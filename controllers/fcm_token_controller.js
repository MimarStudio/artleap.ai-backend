const FcmToken = require("./../models/fcm_token_model");

const registerToken = async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;
   
    if (!userId || !fcmToken) {
      return res.status(400).json({ message: "userId and fcmToken are required" });
    }

    let userTokens = await FcmToken.findOne({ userId });

    if (userTokens) {
      if (!userTokens.tokens.includes(fcmToken)) {
        userTokens.tokens.push(fcmToken);
        userTokens.updatedAt = Date.now();
        await userTokens.save();
      }
    } else {
      userTokens = new FcmToken({ userId, tokens: [fcmToken] });
      await userTokens.save();
    }

    res.json({ success: true, message: "Token registered successfully" });
  } catch (err) {
    console.error("Error saving token:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

module.exports ={
  registerToken,
}