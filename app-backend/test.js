const mongoose = require('mongoose');

// INSERT YOUR ACTUAL PASSWORD HERE (No brackets!)
const MONGO_URI = 'mongodb+srv://jatinarora:Jatin7340@cluster0.qcwv1mc.mongodb.net/?appName=Cluster0';

console.log("Attempting to connect to MongoDB...");

mongoose.connect(MONGO_URI, { 
    serverSelectionTimeoutMS: 5000 // Timeout after 5 seconds instead of 10
})
.then(() => {
    console.log("✅ SUCCESS! Connected to MongoDB Atlas.");
    process.exit(0);
})
.catch(err => {
    console.log("❌ CONNECTION FAILED!");
    console.log("The real error is:", err.message);
    process.exit(1);
});