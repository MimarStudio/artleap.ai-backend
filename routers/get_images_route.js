const express = require("express");
const { getAllImages , getAllImagesByAmdin} = require("../controllers/image_controller");
const router = express.Router();

router.get("/all-images", getAllImages);
router.get("/all-images-admin", getAllImagesByAmdin);
module.exports = router;
