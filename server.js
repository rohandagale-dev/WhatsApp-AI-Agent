const express = require('express')
const {startWhatsApp} = require('./services/whatsappService')
require('dotenv').config();

const app = express();

app.use(express.json());

app.get('/', (req, res)=>{
    res.send("server is running healthy");
})

app.listen(5000,async()=>{
    console.log("Server is running on port 5000");
    await startWhatsApp();
});