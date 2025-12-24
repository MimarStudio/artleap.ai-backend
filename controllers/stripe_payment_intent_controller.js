const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class PaymentIntentController {
  async createPaymentIntent(req, res) {
    try {
      const { amount, currency, userId, planId } = req.body;

      if (!amount || !currency || !userId || !planId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: amount, currency, userId, or planId',
        });
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount, 
        currency,
        metadata: { userId, planId },
        automatic_payment_methods: {
          enabled: true,
        },
      });

      res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
      });
    } catch (error) {
      console.error('[createPaymentIntent] Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = new PaymentIntentController();