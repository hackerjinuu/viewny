const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;

// Secrets: set these in Vercel → Project → Settings → Environment Variables.
// (The old values stay as a fallback so nothing breaks, but move them out of the code.)
const JWT_SECRET = process.env.JWT_SECRET || "my_super_secret_app_key_123!";

// Admin login (used by the jarecut app's Admin screen and admin.html).
// Only a bcrypt hash of the password is stored; the password itself is not in the code or the app.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'jatin@gmail.com').toLowerCase();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '$2a$12$2YogCT/R/nEFrTJ4nNzR5e2f5nQefw/DQ17/BapuTFl1wh7w1nHCO';

// Free trial: length and exports per day (India time)
const TRIAL_DAYS = 5;
const TRIAL_DAILY_EXPORTS = 5;

// AI hook writer (Groq). Put your key in Vercel → Settings → Environment Variables as GROQ_API_KEY.
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b').split(',').map(s => s.trim()).filter(Boolean);
// AI hooks per day (India time) for each plan
const AI_DAILY = { pro: 100, trial: 25, free: 3 };

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// --- 1. MongoDB Setup ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://jatinarora:Jatin7340@cluster0.qcwv1mc.mongodb.net/?appName=Cluster0';

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
    customScriptedRate: { type: Number, default: null },
    // jarecut access: 'free' (no exports unless on trial) or 'pro' (unlimited, set by admin)
    plan: { type: String, default: 'free' },
    trialStartedAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },
    exportDay: { type: String, default: '' },   // YYYY-MM-DD (India time) the count below belongs to
    exportCount: { type: Number, default: 0 },
    exportsTotal: { type: Number, default: 0 },
    aiDay: { type: String, default: '' },        // YYYY-MM-DD the AI count below belongs to
    aiCount: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// ---- jarecut access helpers ----
const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const findUserByEmail = (email) => User.findOne({ email: new RegExp('^' + escapeRe(String(email || '').trim()) + '$', 'i') });

function accessOf(user) {
    const now = Date.now();
    const pro = user.plan === 'pro';
    const trialActive = !!(user.trialEndsAt && new Date(user.trialEndsAt).getTime() > now);
    const used = user.exportDay === istDay() ? (user.exportCount || 0) : 0;
    const limit = pro ? null : (trialActive ? TRIAL_DAILY_EXPORTS : 0);
    const remaining = limit === null ? null : Math.max(0, limit - used);
    const msLeft = trialActive ? new Date(user.trialEndsAt).getTime() - now : 0;
    let message = '';
    if (pro) message = 'Pro: unlimited exports.';
    else if (trialActive) message = remaining > 0 ? `Free trial: ${remaining} of ${limit} exports left today.` : `You used all ${limit} exports for today. More tomorrow.`;
    else if (user.trialEndsAt) message = 'Your free trial has ended. Ask the admin to extend it or upgrade to Pro.';
    else message = 'Exports need a free trial or Pro. Ask the admin to start your 5-day trial.';
    return {
        plan: pro ? 'pro' : (trialActive ? 'trial' : 'free'),
        trial: {
            active: trialActive,
            startedAt: user.trialStartedAt ? new Date(user.trialStartedAt).getTime() : null,
            endsAt: user.trialEndsAt ? new Date(user.trialEndsAt).getTime() : null,
            daysLeft: trialActive ? Math.ceil(msLeft / 86400000) : 0
        },
        exports: { used, limit, remaining, total: user.exportsTotal || 0 },
        canExport: pro || (trialActive && remaining > 0),
        message
    };
}

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

// jarecut: what this user may do right now
apiRouter.get('/user/access', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userEmail });
        if (!user) return res.status(404).json({ error: "User not found." });
        res.status(200).json(accessOf(user));
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

// jarecut: take one export from today's allowance (call before exporting)
apiRouter.post('/user/export/begin', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userEmail });
        if (!user) return res.status(404).json({ error: "User not found." });
        const a = accessOf(user);
        if (!a.canExport) return res.status(403).json({ error: a.message, access: a });
        const today = istDay();
        if (user.exportDay !== today) { user.exportDay = today; user.exportCount = 0; }
        user.exportCount += 1;
        user.exportsTotal = (user.exportsTotal || 0) + 1;
        await user.save();
        res.status(200).json({ status: "success", access: accessOf(user) });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

// jarecut: AI writes the on-screen top hook from the video's transcript (Groq)
const HOOK_SYSTEM = `You write the on-screen HOOK headline for short vertical videos (Reels, Shorts, TikTok).
The hook sits at the top of the video and must make people stop scrolling in the first second.
You get the video's transcript. Write 5 different hook options, then pick the best one.
Rules:
- Max 8 words each. Short, punchy, easy to read in one glance.
- Same language and style as the transcript (Hindi stays Hindi, Hinglish stays Hinglish in Latin letters, English stays English).
- Use proven angles: curiosity gap, bold claim, surprising number, mistake/warning, "how to", contrarian take.
- Only promise what the video actually says. No made-up facts, no fake numbers.
- No hashtags, no quotes around the text, at most one emoji and only if it really fits.
Answer ONLY with JSON: {"hooks":[{"text":"...","angle":"curiosity|claim|number|warning|howto|contrarian"}],"best":0}`;

async function groqHooks(transcript, durationSec) {
    const user = `Video length: ${Math.round(durationSec || 0)} seconds.\nTranscript:\n"""${transcript}"""`;
    let lastErr = null;
    for (const model of GROQ_MODELS) {
        // first with the extra settings for reasoning models, then plain (in case this model rejects them)
        for (const extra of [{ reasoning_effort: 'low', include_reasoning: false }, {}]) {
            try {
                const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model, temperature: 0.9, max_completion_tokens: 1200,
                        response_format: { type: 'json_object' },
                        messages: [{ role: 'system', content: HOOK_SYSTEM }, { role: 'user', content: user }],
                        ...extra
                    })
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                    lastErr = new Error((j.error && j.error.message) || `Groq error ${r.status}`);
                    if (r.status === 400 && Object.keys(extra).length) continue;   // retry without the extras
                    break;                                                         // busy / limit: try the next model
                }
                const text = (((j.choices || [])[0] || {}).message || {}).content || '';
                let parsed = null;
                try { parsed = JSON.parse(text); } catch (e) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} } }
                const hooks = ((parsed && parsed.hooks) || [])
                    .map(h => ({ text: String((h && h.text) || h || '').replace(/^["'“”]+|["'“”]+$/g, '').trim(), angle: String((h && h.angle) || '') }))
                    .filter(h => h.text && h.text.split(/\s+/).length <= 14).slice(0, 5);
                if (!hooks.length) { lastErr = new Error('The AI returned no usable hooks.'); break; }
                let best = parseInt(parsed.best, 10); if (!(best >= 0 && best < hooks.length)) best = 0;
                return { hooks, best, model };
            } catch (e) { lastErr = e; break; }
        }
    }
    throw lastErr || new Error('AI is busy. Try again in a minute.');
}

apiRouter.post('/user/ai/hook', requireAuth, async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(503).json({ error: "AI hooks are not set up on the server yet (GROQ_API_KEY missing)." });
        const transcript = String((req.body || {}).transcript || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
        if (transcript.split(' ').length < 5) return res.status(400).json({ error: "Not enough speech in this clip to write a hook." });
        const user = await User.findOne({ email: req.userEmail });
        if (!user) return res.status(404).json({ error: "User not found." });
        const plan = accessOf(user).plan;
        const limit = AI_DAILY[plan] || AI_DAILY.free;
        const today = istDay();
        if (user.aiDay !== today) { user.aiDay = today; user.aiCount = 0; }
        if (user.aiCount >= limit) return res.status(429).json({ error: `You used all ${limit} AI hooks for today. More tomorrow.` });
        const out = await groqHooks(transcript, (req.body || {}).duration);
        user.aiCount += 1;
        await user.save();
        res.status(200).json({ status: "success", ...out, left: Math.max(0, limit - user.aiCount) });
    } catch (error) { res.status(502).json({ error: error.message || "AI error" }); }
});

// jarecut: give the export back if it failed or was cancelled
apiRouter.post('/user/export/cancel', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userEmail });
        if (!user) return res.status(404).json({ error: "User not found." });
        if (user.exportDay === istDay() && user.exportCount > 0) {
            user.exportCount -= 1;
            user.exportsTotal = Math.max(0, (user.exportsTotal || 1) - 1);
            await user.save();
        }
        res.status(200).json({ status: "success", access: accessOf(user) });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
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

adminRouter.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    const ok = String(email || '').trim().toLowerCase() === ADMIN_EMAIL && password && await bcrypt.compare(String(password), ADMIN_PASSWORD_HASH);
    if (ok) {
        const token = jwt.sign({ email: ADMIN_EMAIL, role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
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
        } else res.status(400).json({ error: "This payout is not pending." });
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


// ---- jarecut: free trial + plan control ----
const userCard = (u) => ({ name: u.name, email: u.email, ...accessOf(u) });

adminRouter.get('/access/:email', requireAdminAuth, async (req, res) => {
    try {
        const user = await findUserByEmail(req.params.email);
        if (!user) return res.status(404).json({ error: "No account with this email. The user must sign up first." });
        res.json(userCard(user));
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/access/:email/trial/start', requireAdminAuth, async (req, res) => {
    try {
        const user = await findUserByEmail(req.params.email);
        if (!user) return res.status(404).json({ error: "No account with this email. The user must sign up first." });
        const days = Math.max(1, Math.min(365, parseInt((req.body || {}).days || TRIAL_DAYS, 10) || TRIAL_DAYS));
        user.trialStartedAt = new Date();
        user.trialEndsAt = new Date(Date.now() + days * 86400000);
        await user.save();
        res.json({ status: "success", message: `${days}-day trial started.`, user: userCard(user) });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/access/:email/trial/extend', requireAdminAuth, async (req, res) => {
    try {
        const user = await findUserByEmail(req.params.email);
        if (!user) return res.status(404).json({ error: "User not found" });
        const days = Math.max(1, Math.min(365, parseInt((req.body || {}).days || 1, 10) || 1));
        const from = Math.max(Date.now(), user.trialEndsAt ? new Date(user.trialEndsAt).getTime() : 0);
        if (!user.trialStartedAt) user.trialStartedAt = new Date();
        user.trialEndsAt = new Date(from + days * 86400000);
        await user.save();
        res.json({ status: "success", message: `Trial extended by ${days} day(s).`, user: userCard(user) });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/access/:email/trial/end', requireAdminAuth, async (req, res) => {
    try {
        const user = await findUserByEmail(req.params.email);
        if (!user) return res.status(404).json({ error: "User not found" });
        if (user.trialEndsAt && new Date(user.trialEndsAt).getTime() > Date.now()) user.trialEndsAt = new Date();
        await user.save();
        res.json({ status: "success", message: "Trial ended.", user: userCard(user) });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

adminRouter.post('/access/:email/plan', requireAdminAuth, async (req, res) => {
    try {
        const user = await findUserByEmail(req.params.email);
        if (!user) return res.status(404).json({ error: "User not found" });
        const plan = (req.body || {}).plan === 'pro' ? 'pro' : 'free';
        user.plan = plan;
        await user.save();
        res.json({ status: "success", message: plan === 'pro' ? "User is now Pro (unlimited exports)." : "Pro removed.", user: userCard(user) });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});

// everyone with a trial (running or ended) or Pro, newest first
adminRouter.get('/access', requireAdminAuth, async (req, res) => {
    try {
        const users = await User.find({ $or: [{ trialEndsAt: { $ne: null } }, { plan: 'pro' }] }).sort({ trialStartedAt: -1 }).limit(300);
        res.json(users.map(userCard));
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