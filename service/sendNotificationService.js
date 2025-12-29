const { saveNotification, sendPushNotification, getDeviceTokens } = require("./firebaseService");

const SendNotificationService = {
  sendCustomNotification: async (receiverUserId, senderUserId, notificationConfig) => {
    try {

      const deviceTokens = await getDeviceTokens(receiverUserId);

      const notifData = {
        title: notificationConfig.title,
        body: notificationConfig.body,
        data:  stringifyData(notificationConfig.data),
      };

      const contextInfo = {
        action: notificationConfig.action || "custom",
        receiverUserId: receiverUserId,
        senderUserId: senderUserId,
        tokenCount: deviceTokens?.length || 0,
        ...notificationConfig.contextInfo
      };

      if (deviceTokens.length > 0) {
        await sendPushNotification(deviceTokens, notifData, contextInfo);
      } else {
      
      }

      await saveNotification({
        userId: receiverUserId,
        type: notificationConfig.type || "user",
        title: notifData.title,
        body: notifData.body,
        data: notifData.data,
      });

    } catch (error) {
      console.error("Notification service error:", error);
      throw error;
    }
  }
};

function stringifyData(data = {}) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] =
      value === undefined || value === null
        ? ""
        : typeof value === "string"
        ? value
        : JSON.stringify(value);
  }
  return result;
}


module.exports = SendNotificationService;