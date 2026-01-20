const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

if (!process.env.AWS_REGION) {
  throw new Error('AWS_REGION environment variable is required');
}

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const uploadImageFromUrl = async (imageUrl, bucketName) => {
  const ext = path.extname(imageUrl) || '.jpg';
  const key = `leonardo/outputs/${uuidv4()}${ext}`;

  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });

  const uploadParams = {
    Bucket: bucketName,
    Key: key,
    Body: response.data,
    ContentType: response.headers['content-type']
  };
  await s3.send(new PutObjectCommand(uploadParams));

  return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};


const uploadVideoToS3 = async (filePath, userId, bucketName) => {

  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found at path: ${filePath}`);
  }

  if (!bucketName || !bucketName.trim()) {
    console.error('[S3] Bucket name is required');
    throw new Error('Bucket name is required');
  }

  if (!userId || !userId.trim()) {
    console.error('[S3] User ID is required for video organization');
    throw new Error('User ID is required for video organization');
  }

  if (!process.env.AWS_REGION) {
    console.error('[S3] AWS_REGION environment variable is not set');
    throw new Error('AWS_REGION environment variable is required');
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const fileName = `${uuidv4()}${ext}`;
    const key = `videos/${Date.now()}/${fileName}`;

    const uploadParams = {
      Bucket: bucketName,
      Key: key,
      Body: fileBuffer,
      ContentType: 'video/mp4',
    };

    await s3.send(new PutObjectCommand(uploadParams));

    const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    
    return s3Url;
  } catch (error) {
    console.error(`[S3] Video upload failed to bucket ${bucketName}:`, error.message);
    throw new Error(`Failed to upload video to S3: ${error.message}`);
  }
};

module.exports = { uploadImageFromUrl, uploadVideoToS3 };
