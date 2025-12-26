const admin = require('firebase-admin');
const { sendPasswordResetEmail } = require('./../utils/emailSender');

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        return res.status(404).json({
          success: false,
          message: "No account found with this email.",
        });
      }
      throw error;
    }

    const resetLink = await admin.auth().generatePasswordResetLink(email);
    try {
      await sendPasswordResetEmail(
        email, 
        resetLink, 
        userRecord.displayName || 'Artleap User'
      );
      
      return res.status(200).json({
        success: true,
        message: "Password reset link has been sent to your email.",
      });

    } catch (emailError) {
      console.error("Email sending error:", emailError);
      return res.status(500).json({
        success: false,
        message: "Failed to send password reset email. Please try again.",
      });
    }

  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
};

module.exports = {
  forgotPassword,
};