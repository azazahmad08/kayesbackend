require("dotenv").config();
require("express-async-errors");

const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const { body, validationResult } = require("express-validator");
const mongoose = require("mongoose");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 5000;

/* ----------------- Allowed Categories ----------------- */
const ALLOWED_CATEGORIES = [
  "Best Selling",
  "New Arrivals",
  "Children Items",
  "Jewellery",
  "Accessories",
  "Gifts",
  "Clothing",
];

/* ----------------- DB Connect and Start Server ----------------- */
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI missing in .env");
  process.exit(1);
}

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB connected");
});
mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err);
});
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected");
});

const startServer = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000, // wait up to 30s
    });

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
};

startServer();

/* ----------------- Middlewares ----------------- */
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

/* ----------------- Helpers ----------------- */
const { Types } = mongoose;
const isValidObjectId = (v) => Types.ObjectId.isValid(v);

/* ----------------- Models ----------------- */
/** Product */
const ProductSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, trim: true },
  description: { type: String },
  price: { type: Number, required: true, min: 0 },
  priceAfterDiscount: { type: Number, min: 0 },
  imageUrl: { type: String },
  sizes: { type: [String], default: ["S", "M", "L", "XL", "XXL"] },
  categories: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) =>
        Array.isArray(arr) && arr.every((c) => ALLOWED_CATEGORIES.includes(c)),
      message: () =>
        `Invalid category found. Allowed: ${ALLOWED_CATEGORIES.join(", ")}`,
    },
  },
  createdAt: { type: Date, default: Date.now },
});
ProductSchema.index({ createdAt: -1 });
ProductSchema.index({ title: "text", description: "text", code: "text" });

const Product = mongoose.model("Product", ProductSchema);

/** Order */
const OrderProductSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    title: String,
    code: String,
    price: Number,
    quantity: { type: Number, default: 1, min: 1 },
    size: String,
    color: String, // ✅ product-level color
    imageUrl: String,
    category: String,
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema({
  products: { type: [OrderProductSchema], required: true },
  customerName: { type: String, trim: true },
  phone: { type: String, trim: true },
  division: { type: String, trim: true },
  district: { type: String, trim: true },
  upazila: { type: String, trim: true },
  address: { type: String },
  color: { type: String, trim: true, default: "" }, // ✅ top-level color (from ProcessPage form)
  totalValue: { type: Number, required: true, min: 0 },
  deliveryCharge: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    default: "pending",
    enum: ["pending", "processing", "delivered", "cancelled"],
  },
  createdAt: { type: Date, default: Date.now },
  customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
});

const Order = mongoose.model("Order", OrderSchema);

/** Color (optional master list) */
const ColorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  hex: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now },
});
const Color = mongoose.model("Color", ColorSchema);

/* ----------------- Image Upload (ImgBB) ----------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype);
    if (!ok) return cb(new Error("Only image files allowed"));
    cb(null, true);
  },
});

app.post("/api/products/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    const imgbbKey = process.env.IMGBB_KEY;
    if (!imgbbKey) {
      return res.status(500).json({ message: "IMGBB_KEY missing in .env" });
    }
    const formData = new FormData();
    formData.append("image", req.file.buffer.toString("base64"));
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${imgbbKey}`,
      formData,
      { headers: formData.getHeaders(), timeout: 100000 }
    );
    const { url, display_url } = response?.data?.data || {};
    res.json({ url: url || display_url });
  } catch (err) {
    console.error("Upload failed:", err.message);
    res.status(500).json({ message: "Image upload failed" });
  }
});

/* ----------------- Product CRUD ----------------- */
app.post(
  "/api/products",
  [body("title").notEmpty(), body("code").notEmpty(), body("price").isNumeric()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { title, code, description, price, priceAfterDiscount, imageUrl, categories, sizes } = req.body;

    const exists = await Product.findOne({ code });
    if (exists)
      return res.status(400).json({ message: "Product code must be unique" });

    const p = new Product({
      title,
      code,
      description,
      price,
      priceAfterDiscount,
      imageUrl,
      categories: categories || [],
      sizes: sizes || ["S", "M", "L", "XL", "XXL"],
    });
    await p.save();
    res.status(201).json(p);
  }
);

app.get("/api/products", async (req, res) => {
  const { categories, search } = req.query;
  const q = {};
  if (categories) {
    const list = String(categories).split(",").map((s) => s.trim());
    if (list.length) q.categories = { $in: list };
  }
  if (search) q.$text = { $search: String(search) };
  const products = await Product.find(q).sort({ createdAt: -1 });
  res.json(products);
});

app.get("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid product id" });
  const p = await Product.findById(id);
  if (!p) return res.status(404).json({ message: "Product not found" });
  res.json(p);
});

app.put("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid product id" });
  const p = await Product.findById(id);
  if (!p) return res.status(404).json({ message: "Product not found" });
  Object.assign(p, req.body);
  await p.save();
  res.json(p);
});

app.delete("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid product id" });
  const p = await Product.findById(id);
  if (!p) return res.status(404).json({ message: "Product not found" });
  await Product.findByIdAndDelete(id);
  res.json({ message: "Product removed" });
});

/* ----------------- Orders ----------------- */
app.post("/api/orders", async (req, res) => {
  const {
    products,
    customerName,
    phone,
    division,
    district,
    upazila,
    address,
    color, // ✅ top-level color from ProcessPage
    deliveryCharge,
    customFields
  } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: "Products are required" });
  }

  let productTotal = 0;
  const detailed = [];

  for (const p of products) {
    const pid = p?.productId;
    if (!pid || !isValidObjectId(pid)) {
      return res.status(400).json({ message: `Invalid productId: ${pid}` });
    }
    const prod = await Product.findById(pid);
    if (!prod) {
      return res.status(400).json({ message: `Product ${pid} not found` });
    }
    const unitPrice =
      typeof prod.priceAfterDiscount === "number" && prod.priceAfterDiscount >= 0
        ? prod.priceAfterDiscount
        : prod.price;
    const qty = Number(p.quantity ?? 1) || 1;
    productTotal += unitPrice * qty;

    detailed.push({
      productId: prod._id,
      title: prod.title,
      code: prod.code,
      price: unitPrice,
      quantity: qty,
      size: p.size || null,
      color: (p.color ?? "").toString().trim(), // ✅ include product-level color
      imageUrl: p.imageUrl || prod.imageUrl || "",
      category: p.category || (prod.categories?.[0] || null),
      customFields: p.customFields || {},
    });
  }

  const order = new Order({
    products: detailed,
    customerName,
    phone,
    division,
    district,
    upazila,
    address,
    color: (color ?? "").toString().trim(), // ✅ save top-level color
    totalValue: productTotal,
    deliveryCharge: Number(deliveryCharge || 0),
    customFields: customFields || {},
  });

  await order.save();
  res.status(201).json(order);
});

app.get("/api/orders", async (req, res) => {
  const orders = await Order.find()
    .sort({ createdAt: -1 })
    .populate("products.productId", "title code");
  res.json(orders);
});

app.get("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid order id" });
  const order = await Order.findById(id).populate(
    "products.productId",
    "title code"
  );
  if (!order) return res.status(404).json({ message: "Order not found" });
  res.json(order);
});

app.put("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid order id" });
  const order = await Order.findById(id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  Object.assign(order, req.body);
  await order.save();
  res.json(order);
});

app.patch("/api/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid order id" });
  const order = await Order.findById(id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  order.status = req.body.status ?? order.status;
  await order.save();
  res.json(order);
});

app.delete("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id))
    return res.status(400).json({ message: "Invalid order id" });
  const order = await Order.findById(id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  await Order.findByIdAndDelete(id);
  res.json({ message: "Order removed" });
});

/* ----------------- Colors (Optional master list) ----------------- */
app.post("/api/colors", async (req, res) => {
  const { name, hex } = req.body;
  if (!name) return res.status(400).json({ message: "Color name required" });

  const c = new Color({ name, hex });
  await c.save();
  res.status(201).json(c);
});

app.get("/api/colors", async (req, res) => {
  const colors = await Color.find().sort({ createdAt: -1 });
  res.json(colors);
});

/* ----------------- Dashboard ----------------- */
app.get("/api/dashboard/total-sales", async (req, res) => {
  const result = await Order.aggregate([
    { $group: { _id: null, total: { $sum: "$totalValue" }, count: { $sum: 1 } } },
  ]);
  const data = result[0] || { total: 0, count: 0 };
  res.json({ totalBDT: data.total, totalOrders: data.count });
});

app.get("/api/dashboard/monthly-sales", async (req, res) => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  const result = await Order.aggregate([
    { $match: { createdAt: { $gte: sixMonthsAgo } } },
    {
      $group: {
        _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
        total: { $sum: "$totalValue" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);
  res.json(
    result.map((r) => ({
      year: r._id.year,
      month: r._id.month,
      total: r.total,
      count: r.count,
    }))
  );
});

/* ----------------- Root & Error Handler ----------------- */
app.get("/", (req, res) => res.send("✅ Rootx Admin Backend running"));

app.use((err, req, res, next) => {
  console.error("❌", err.stack);
  res
    .status(err.status || 500)
    .json({ message: err.message || "Internal Server Error" });
});
