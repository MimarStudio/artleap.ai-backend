const express = require("express");
const { getAllImages , getAllImagesByAdmin} = require("../controllers/image_controller");
const router = express.Router();

router.get("/all-images", getAllImages);
router.get("/all-images-admin", getAllImagesByAdmin);
module.exports = router;
