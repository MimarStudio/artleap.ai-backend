const axios = require("axios");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const mongoose = require("mongoose");
const SubscriptionPlan = require("./../../models/subscriptionPlan_model");
const appleConfig = require("./../../config/apple");
const { mapAppleProductType, mapAppleProductName, mapAppleBillingPeriod, mapAppleToGoogleProductId } = require("./../../utils/appleUtils");
const { calculateCredits, parseFeatures, getPlanDetails } = require("./../../utils/googleUtils");

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function briefAxiosError(err) {
  const status = err.response?.status;
  const statusText = err.response?.statusText;
  const data = err.response?.data;
  return { message: err.message, status, statusText, data };
}

async function withRetry(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (attempt < retries && (status === 429 || (status >= 500 && status < 600))) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function getAllPages(url, headers) {
  const all = [];
  let next = url;
  while (next) {
    const { data } = await withRetry(() => axios.get(next, { headers }));
    if (Array.isArray(data?.data)) all.push(...data.data);
    next = data?.links?.next || null;
  }
  return all;
}

class ApplePlanSyncService {
  constructor() {
    this.appId = appleConfig.appId;
    this.issuerId = appleConfig.issuerId;
    this.keyId = appleConfig.keyId;
    this.privateKey = fs.readFileSync(appleConfig.privateKeyPath, "utf8");
    this.baseURL = "https://api.appstoreconnect.apple.com/v1";
  }

  async generateToken() {
    const now = Math.floor(Date.now() / 1000) - 30; // backdate for clock skew

    return jwt.sign(
      {
        iss: this.issuerId,
        iat: now,
        exp: now + 15 * 60,
        aud: "appstoreconnect-v1",
      },
      this.privateKey,
      {
        algorithm: "ES256",
        keyid: this.keyId,
      }
    );
  }


  async checkDatabaseConnection() {
    try {
      if (mongoose.connection.readyState !== 1) throw new Error("MongoDB connection not ready");
      await mongoose.connection.db.admin().ping();
    } catch (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }
  }

  isFreePlan(productId) {
    return productId === "free" || productId?.toLowerCase?.().includes("free");
  }

  async fetchAppleProducts(headers) {
    const groupsUrl = `${this.baseURL}/apps/${this.appId}/subscriptionGroups`;
    const groups = await getAllPages(groupsUrl, headers);
    const products = [];
    for (const group of groups) {
      const subsUrl = `${this.baseURL}/subscriptionGroups/${group.id}/subscriptions`;
      const subscriptions = await getAllPages(subsUrl, headers);
      for (const sub of subscriptions) {
        const subId = sub.id;
        const attributes = sub.attributes || {};
        const productId = attributes.productId;
        const locUrl = `${this.baseURL}/subscriptions/${subId}/subscriptionLocalizations`;
        let localizationName = attributes.name || productId;
        let localizationDesc = "";
        try {
          const locs = await getAllPages(locUrl, headers);
          if (Array.isArray(locs) && locs.length > 0) {
            const en = locs.find((x) => x.attributes?.locale === "en-US");
            const chosen = en?.attributes || locs[0]?.attributes || {};
            localizationName = chosen.name || localizationName;
            localizationDesc = chosen.description || "";
          }
        } catch { }
        let price = 0;
        try {
          const pricesUrl = `${this.baseURL}/subscriptions/${subId}/prices?include=subscriptionPricePoint,territory&filter[territory]=USA`;
          const { data } = await withRetry(() => axios.get(pricesUrl, { headers }));
          const included = data?.included || [];
          const pricePoint = included.find((i) => i.type === "subscriptionPricePoints");
          price = num(pricePoint?.attributes?.customerPrice, 0);
        } catch { }
        products.push({
          productId,
          name: localizationName || attributes.name || productId,
          description: localizationDesc || "",
          status: attributes.state,
          price,
          subscriptionPeriod: attributes.subscriptionPeriod,
          fullObject: sub
        });
      }
    }
    return products;
  }

  async syncPlansWithAppStore() {
    try {
      await this.checkDatabaseConnection();
      const token = await this.generateToken();
      const headers = { Authorization: `Bearer ${token}` };
      const appleProducts = await this.fetchAppleProducts(headers);
      const existingPlans = await SubscriptionPlan.find().lean().exec();
      const byAppleId = new Map();
      const byGoogleId = new Map();
      for (const p of existingPlans) {
        if (p.appleProductId) byAppleId.set(p.appleProductId, p);
        if (p.googleProductId) byGoogleId.set(p.googleProductId, p);
      }
      const ops = [];
      for (const product of appleProducts) {
        const productId = product?.productId;
        if (!productId) continue;
        const type = mapAppleProductType(productId);
        const mappedGoogleId = mapAppleToGoogleProductId(productId) || null;
        const existingPlan =
          byAppleId.get(productId) ||
          (mappedGoogleId ? byGoogleId.get(mappedGoogleId) : null);
        const planDetails = getPlanDetails(productId, product);
        const candidateGoogleId =
          mappedGoogleId || existingPlan?.googleProductId || null;

        const basePlanData = {
          appleProductId: productId,
          name: mapAppleProductName(productId),
          type,
          description: planDetails.description || product.description || "",
          price: num(planDetails.price ?? product.price, 0),
          totalCredits: num(calculateCredits(productId), 0),
          imageGenerationCredits: num(calculateCredits(productId, "image"), 0),
          promptGenerationCredits: num(calculateCredits(productId, "prompt"), 0),
          features: Array.isArray(parseFeatures(product.description)) ? parseFeatures(product.description) : [],
          isActive: true,
          version: existingPlan ? num(existingPlan.version, 0) + 1 : 1,
          billingPeriod: mapAppleBillingPeriod(product.subscriptionPeriod),
          updatedAt: new Date()
        };

        if (existingPlan) {
          const setDoc = { ...basePlanData };
          if (candidateGoogleId) setDoc.googleProductId = candidateGoogleId;
          ops.push({
            updateOne: {
              filter: { _id: existingPlan._id },
              update: { $set: setDoc }
            }
          });
        } else {
          const createDoc = { ...basePlanData };
          if (candidateGoogleId) createDoc.googleProductId = candidateGoogleId;
          ops.push({ insertOne: { document: createDoc } });
        }
      }

      if (ops.length) await SubscriptionPlan.bulkWrite(ops, { ordered: false });

      const activeAppleIds = new Set(appleProducts.map((p) => p.productId).filter(Boolean));
      const deactivations = [];
      for (const plan of existingPlans) {
        if (plan.appleProductId && !activeAppleIds.has(plan.appleProductId) && !this.isFreePlan(plan.appleProductId)) {
          deactivations.push(
            SubscriptionPlan.updateOne(
              { _id: plan._id },
              { $set: { isActive: false, updatedAt: new Date() } }
            )
          );
        }
      }
      if (deactivations.length) await Promise.all(deactivations);
    } catch (error) {
      const details = briefAxiosError(error);
      throw new Error(`Failed to sync plans with App Store: ${JSON.stringify(details)}`);
    }
  }
}

module.exports = ApplePlanSyncService;
