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
    currencySymbol: { type: String, default: "$" },
    customRegularRate: { type: Number, default: null },
    customScriptedRate: { type: Number, default: null } 
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

const settingsSchema = new mongoose.Schema({
    key: { type: String, unique: true, default: 'rates' },
    regularRate: { type: Number, default: 0.30 },
    scriptedRate: { type: Number, default: 0.50 }
});
const Settings = mongoose.model('Settings', settingsSchema);

const targetSchema = new mongoose.Schema({
    userEmail: { type: String, required: true, unique: true },
    title: { type: String, default: "500K Views Milestone" },
    targetType: { type: String, default: "VIEWS" },
    targetViews: { type: Number, default: 500000 },
    targetEarnings: { type: Number, default: 150 },
    timeframe: { type: String, default: "All-time" },
    isActive: { type: Boolean, default: true }
});
const Target = mongoose.model('Target', targetSchema);


// --- 2. USER API ROUTES ---
const apiRouter = express.Router();

// Version Control Middleware
apiRouter.use((req, res, next) => {
    if (req.path === '/app/version') return next();

    const appVersion = parseInt(req.headers['x-app-version'] || '0', 10);
    const MIN_REQUIRED_VERSION = 2;

    if (appVersion < MIN_REQUIRED_VERSION) {
        return res.status(426).json({
            error: "Please update to the latest version of Viewny to continue."
        });
    }
    next();
});

apiRouter.get('/app/version', (req, res) => {
    res.status(200).json({
        versionCode: 2,
        versionName: "2.0",
        forceUpdate: true,
        downloadUrl: "https://viewny-download.vercel.app/",
        updateNotes: "🚀 Viewny 2.0: Important update! Please install the new version to continue."
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

apiRouter.get('/user/balance', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userEmail });
        res.status(200).json({ withdrawableBalance: user.withdrawableBalance, currencySymbol: user.currencySymbol });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

apiRouter.get('/user/rates', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userEmail });
        let settings = await Settings.findOne({ key: 'rates' });
        if (!settings) {
            settings = await Settings.create({ key: 'rates', regularRate: 0.30, scriptedRate: 0.50 });
        }

        const regular = (user && user.customRegularRate !== null && user.customRegularRate !== undefined) ? user.customRegularRate : settings.regularRate;
        const scripted = (user && user.customScriptedRate !== null && user.customScriptedRate !== undefined) ? user.customScriptedRate : settings.scriptedRate;

        res.status(200).json({ regularRate: regular, scriptedRate: scripted });
    } catch (error) {
        res.status(200).json({ regularRate: 0.30, scriptedRate: 0.50 });
    }
});

apiRouter.post('/user/views', requireAuth, async (req, res) => {
    const { title, platform, logType, views, ratePerThousand, dateMillis } = req.body;
    try {
        const user = await User.findOne({ email: req.userEmail });
        
        let settings = await Settings.findOne({ key: 'rates' });
        if (!settings) {
            settings = { regularRate: 0.30, scriptedRate: 0.50 };
        }
        
        const activeLogType = logType || 'Regular';
        
        let applicableRate = 0;
        if (activeLogType === 'Scripted') {
            applicableRate = (user.customScriptedRate !== null && user.customScriptedRate !== undefined) 
                ? user.customScriptedRate 
                : settings.scriptedRate;
        } else {
            applicableRate = (user.customRegularRate !== null && user.customRegularRate !== undefined) 
                ? user.customRegularRate 
                : settings.regularRate;
        }

        const calculatedEarnings = parseFloat(((views / 1000) * applicableRate).toFixed(2));

        const newEntry = await ViewEntry.create({
            userEmail: req.userEmail,
            title,
            platform,
            logType: activeLogType,
            views,
            earnings: calculatedEarnings,
            ratePerThousand: applicableRate,
            dateMillis
        });

        user.withdrawableBalance += calculatedEarnings;
        user.withdrawableBalance = parseFloat(user.withdrawableBalance.toFixed(2));
        await user.save();

        res.status(201).json({ status: "success", backendId: newEntry._id.toString(), newBalance: user.withdrawableBalance, earnings: calculatedEarnings, ratePerThousand: applicableRate });
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

apiRouter.get('/user/target', requireAuth, async (req, res) => {
    try {
        let target = await Target.findOne({ userEmail: req.userEmail });
        if (!target) {
            target = {
                title: "500K Views Milestone",
                targetType: "VIEWS",
                targetViews: 500000,
                targetEarnings: 150,
                timeframe: "All-time",
                isActive: true
            };
        }
        res.status(200).json(target);
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

apiRouter.post('/user/target', requireAuth, async (req, res) => {
    const { title, targetType, targetViews, targetEarnings, timeframe, isActive } = req.body;
    try {
        let target = await Target.findOne({ userEmail: req.userEmail });
        if (!target) {
            target = new Target({
                userEmail: req.userEmail,
                title: title || "500K Views Milestone",
                targetType: targetType || "VIEWS",
                targetViews: targetViews || 500000,
                targetEarnings: targetEarnings || 150,
                timeframe: timeframe || "All-time",
                isActive: isActive !== undefined ? isActive : true
            });
        } else {
            if (title) target.title = title;
            if (targetType) target.targetType = targetType;
            if (targetViews !== undefined) target.targetViews = targetViews;
            if (targetEarnings !== undefined) target.targetEarnings = targetEarnings;
            if (timeframe) target.timeframe = timeframe;
            if (isActive !== undefined) target.isActive = isActive;
        }
        await target.save();
        res.status(200).json({ status: "success", target });
    } catch (error) { res.status(500).json({ error: "Database error saving target." }); }
});


// --- 3. ADMIN API ROUTES ---
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

adminRouter.get('/rates', requireAdminAuth, async (req, res) => {
    try {
        let settings = await Settings.findOne({ key: 'rates' });
        if (!settings) {
            settings = await Settings.create({ key: 'rates', regularRate: 0.30, scriptedRate: 0.50 });
        }
        res.json({ status: "success", rates: { regularRate: settings.regularRate, scriptedRate: settings.scriptedRate } });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/rates', requireAdminAuth, async (req, res) => {
    const { regularRate, scriptedRate } = req.body;
    const numRegular = parseFloat(regularRate);
    const numScripted = parseFloat(scriptedRate);

    if (isNaN(numRegular) || numRegular < 0 || isNaN(numScripted) || numScripted < 0) {
        return res.status(400).json({ error: "Invalid price values. Prices must be non-negative numbers." });
    }

    try {
        let settings = await Settings.findOne({ key: 'rates' });
        if (!settings) {
            settings = new Settings({ key: 'rates', regularRate: numRegular, scriptedRate: numScripted });
        } else {
            settings.regularRate = numRegular;
            settings.scriptedRate = numScripted;
        }
        await settings.save();
        res.status(200).json({ status: "success", rates: { regularRate: settings.regularRate, scriptedRate: settings.scriptedRate } });
    } catch (error) {
        res.status(500).json({ error: "Database error updating rates." });
    }
});

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

adminRouter.get('/users', requireAdminAuth, async (req, res) => {
    try {
        const users = await User.find({}, 'name email customRegularRate customScriptedRate');
        res.json(users);
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/users/:email/rates', requireAdminAuth, async (req, res) => {
    const { regularRate, scriptedRate } = req.body;
    try {
        const user = await User.findOne({ email: req.params.email });
        if (!user) return res.status(404).json({ error: "User not found" });

        user.customRegularRate = regularRate === '' ? null : parseFloat(regularRate);
        user.customScriptedRate = scriptedRate === '' ? null : parseFloat(scriptedRate);

        await user.save();
        res.json({ status: "success", message: "User rates updated" });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});


// --- 4. MOUNT ROUTERS ---
// CRITICAL FIX: We must mount the Admin router BEFORE the general /v1 API router.
// This prevents the /v1 router's version check from intercepting /v1/admin requests.
app.use('/v1/admin', adminRouter);
app.use('/v1', apiRouter);


// Export for Vercel Serverless Functions
module.exports = app;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Backend API running at: http://localhost:${PORT}/v1/`);
        console.log(`📱 User Dashboard running at: http://localhost:${PORT}/`);
        console.log(`👑 Admin Panel running at: http://localhost:${PORT}/admin.html`);
    });
}