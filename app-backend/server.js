const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;

// Security Secret for JWT tokens
const JWT_SECRET = "my_super_secret_app_key_123!";

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// --- 1. MongoDB Setup ---
const MONGO_URI = 'mongodb+srv://jatinarora:Jatin7340@cluster0.qcwv1mc.mongodb.net/?appName=Cluster0';

let isConnected = false;
const connectDB = async () => {
    if (isConnected || mongoose.connection.readyState >= 1) {
        isConnected = true;
        return;
    }
    try {
        await mongoose.connect(MONGO_URI);
        isConnected = true;
        console.log('✅ Connected to MongoDB Atlas');
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err);
    }
};

app.use(async (req, res, next) => {
    await connectDB();
    next();
});

// Database Schemas
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    withdrawableBalance: { type: Number, default: 0 },
    currencySymbol: { type: String, default: "$" }
});
const User = mongoose.model('User', userSchema);

const payoutSchema = new mongoose.Schema({
    userEmail: String,
    amount: Number,
    method: String,
    accountId: String,
    driveProofLink: String,
    name: String,
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const Payout = mongoose.model('Payout', payoutSchema);

const viewEntrySchema = new mongoose.Schema({
    userEmail: String,
    title: String,
    platform: String,
    logType: { type: String, default: 'Regular' },
    views: Number,
    earnings: Number,
    ratePerThousand: Number,
    dateMillis: Number
});
const ViewEntry = mongoose.model('ViewEntry', viewEntrySchema);


// --- 2. AUTHENTICATION & PUBLIC API ROUTES ---
const apiRouter = express.Router();

apiRouter.get('/app/version', (req, res) => {
    res.status(200).json({
        versionCode: 2,
        versionName: "1.1.0",
        forceUpdate: false,
        downloadUrl: "https://viewny-download.vercel.app/",
        updateNotes: "New features, bug fixes, and security enhancements!"
    });
});

apiRouter.post('/auth/signup', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        if (!name || !name.trim()) return res.status(400).json({ error: "Please enter your Full Name." });
        if (!email || !email.trim()) return res.status(400).json({ error: "Please enter your Email address." });
        if (!password) return res.status(400).json({ error: "Please enter a Password." });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "Email already in use." });

        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ name: name.trim(), email: email.trim(), password: hashedPassword });
        res.status(201).json({ status: "success", message: "User registered successfully!" });
    } catch (error) { res.status(500).json({ error: error.message || "Database error during signup." }); }
});

apiRouter.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: "User not found." });

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) return res.status(401).json({ error: "Invalid password." });

        const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.status(200).json({
            status: "success",
            token: token,
            user: { name: user.name, email: user.email, balance: user.withdrawableBalance }
        });
    } catch (error) { res.status(500).json({ error: "Database error during login." }); }
});

// Security Middleware to protect User routes
const requireAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.status(401).json({ error: "Access denied. Please log in." });

    jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
        if (err) return res.status(403).json({ error: "Invalid or expired session." });
        req.userEmail = decodedUser.email; 
        next(); 
    });
};


// --- 3. SECURED USER API ROUTES ---
apiRouter.get('/user/balance', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userEmail });
        res.status(200).json({ withdrawableBalance: user.withdrawableBalance, currencySymbol: user.currencySymbol });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

apiRouter.post('/user/views', requireAuth, async (req, res) => {
    const { title, platform, logType, views, earnings, ratePerThousand, dateMillis } = req.body;
    try {
        const newEntry = await ViewEntry.create({
            userEmail: req.userEmail,
            title,
            platform,
            logType: logType || 'Regular',
            views,
            earnings,
            ratePerThousand,
            dateMillis
        });

        const user = await User.findOne({ email: req.userEmail });
        user.withdrawableBalance += earnings;
        user.withdrawableBalance = parseFloat(user.withdrawableBalance.toFixed(2));
        await user.save();

        res.status(201).json({ status: "success", backendId: newEntry._id.toString(), newBalance: user.withdrawableBalance });
    } catch (error) { res.status(500).json({ error: "Database error adding view entry." }); }
});

apiRouter.get('/user/views', requireAuth, async (req, res) => {
    try {
        const entries = await ViewEntry.find({ userEmail: req.userEmail }).sort({ dateMillis: -1 });
        res.status(200).json(entries);
    } catch (error) { res.status(500).json({ error: "Database error fetching views." }); }
});

apiRouter.delete('/user/views/:id', requireAuth, async (req, res) => {
    try {
        const entry = await ViewEntry.findById(req.params.id);
        if (!entry || entry.userEmail !== req.userEmail) return res.status(404).json({ error: "Not found" });

        const user = await User.findOne({ email: req.userEmail });
        user.withdrawableBalance -= entry.earnings;
        user.withdrawableBalance = Math.max(0, parseFloat(user.withdrawableBalance.toFixed(2)));
        await user.save();

        await ViewEntry.findByIdAndDelete(req.params.id);
        res.status(200).json({ status: "success", newBalance: user.withdrawableBalance });
    } catch (error) { res.status(500).json({ error: "Database error deleting view." }); }
});

apiRouter.post('/user/payout', requireAuth, async (req, res) => {
    const { amount, method, accountId, driveProofLink, name } = req.body;
    try {
        const user = await User.findOne({ email: req.userEmail });
        if (amount > user.withdrawableBalance) {
            return res.status(400).json({ status: "error", message: "Insufficient balance." });
        }
        
        user.withdrawableBalance -= amount;
        user.withdrawableBalance = parseFloat(user.withdrawableBalance.toFixed(2));
        await user.save();

        await Payout.create({
            userEmail: user.email,
            amount,
            method,
            accountId,
            driveProofLink,
            name,
            status: 'pending'
        });
        res.status(200).json({ status: "success", message: "Payout pending admin approval." });
    } catch (error) { res.status(500).json({ error: "Database error processing payout." }); }
});

apiRouter.get('/user/payouts', requireAuth, async (req, res) => {
    try {
        const payouts = await Payout.find({ userEmail: req.userEmail }).sort({ createdAt: -1 });
        res.status(200).json(payouts);
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});
app.use('/v1', apiRouter);


// --- 4. ADMIN API ROUTES ---
const adminRouter = express.Router();

adminRouter.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (email === 'jatin@gmail.com' && password === 'jatin@123') {
        const token = jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
        return res.json({ status: 'success', token });
    }
    return res.status(401).json({ error: 'Invalid admin credentials.' });
});

const requireAdminAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Admin access denied.' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err || decoded.role !== 'admin') return res.status(403).json({ error: 'Invalid admin session.' });
        next();
    });
};

adminRouter.get('/payouts/pending', requireAdminAuth, async (req, res) => {
    try {
        const payouts = await Payout.find({ status: 'pending' }).sort({ createdAt: 1 });
        res.json(payouts);
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/payouts/:id/approve', requireAdminAuth, async (req, res) => {
    try {
        await Payout.findByIdAndUpdate(req.params.id, { status: 'approved' });
        res.json({ status: "success", message: "Payout approved." });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/payouts/:id/reject', requireAdminAuth, async (req, res) => {
    try {
        const payout = await Payout.findById(req.params.id);
        if (payout && payout.status === 'pending') {
            payout.status = 'rejected';
            await payout.save();
            const user = await User.findOne({ email: payout.userEmail });
            if (user) {
                user.withdrawableBalance += payout.amount;
                user.withdrawableBalance = parseFloat(user.withdrawableBalance.toFixed(2));
                await user.save();
            }
            res.json({ status: "success", message: "Payout rejected and refunded." });
        }
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});
app.use('/v1/admin', adminRouter);


// Export for Vercel Serverless Functions
module.exports = app;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Backend API running at: http://localhost:${PORT}/v1/`);
        console.log(`📱 User Dashboard running at: http://localhost:${PORT}/`);
        console.log(`👑 Admin Panel running at: http://localhost:${PORT}/admin.html`);
    });
}