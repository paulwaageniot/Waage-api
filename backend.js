const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const PDFDocument = require("pdfkit");
const stream = require("stream");

const app = express();
app.use(cors());
app.use(express.json());

const uri = "mongodb+srv://pklose:Start123456@iotcluster.ifvtvb3.mongodb.net/?retryWrites=true&w=majority&appName=IoTCluster";
const client = new MongoClient(uri);

let emailSettings = {
  email: "",
  interval: "daily", // default
};

// 📩 E-Mail speichern vom Frontend
app.post("/email-settings", (req, res) => {
  const { email, interval } = req.body;
  emailSettings = { email, interval };
  console.log("📩 Neue Einstellungen:", emailSettings);
  res.send("✅ E-Mail Einstellungen gespeichert");
});
 // 📤 Manuelles Auslösen per Button
app.post("/send-now", async (req, res) => {
  try {
    if (!emailSettings.email) {
      return res.status(400).send("❌ Keine E-Mail-Adresse gesetzt.");
    }
    await sendReportEmail();
    res.send("✅ E-Mail wurde gesendet");
  } catch (error) {
    console.error("❌ Fehler beim Senden:", error);
    res.status(500).send("❌ Fehler beim Senden");
  }
});
// 📊 Daten-API für das Frontend
app.get("/data", async (req, res) => {
  try {
    await client.connect();
    const daten = await client
      .db("pklose")
      .collection("messwerte")
      .find({})
      .sort({ timestamp: -1 })
      .limit(1000)
      .toArray();
    res.json(daten.reverse());
  } catch (e) {
    res.status(500).send("Fehler beim Abrufen");
  }
});

// 🕒 Geplanter Versand (täglich um 08:00 Uhr)
cron.schedule("0 8 * * *", async () => {
  if (emailSettings.email && emailSettings.interval === "daily") {
    await sendReportEmail();
  }
});

// 📄 PDF GENERIEREN
async function generatePDF(data) {
  const doc = new PDFDocument();
  const bufferStream = new stream.PassThrough();
  doc.pipe(bufferStream);

  doc.fontSize(18).text("📊 IoT Waagen Bericht", { align: "center" });
  doc.moveDown();

  doc.fontSize(12).text(`Datum: ${new Date().toLocaleString("de-DE")}`);
  doc.moveDown();

  doc.text("➤ Zusammenfassung:");
  const last = data[data.length - 1];
  const first = data[0];
  const diff = (field) =>
    (parseFloat(last?.[field] || 0) - parseFloat(first?.[field] || 0)).toFixed(2);

  doc.text(`- Förderleistung (t/h): ${(first.gewicht * first.bandgeschwindigkeit * first.korrekturfaktor * 3.6).toFixed(2)}`);
  doc.text(`- Gewicht (kg): Ø ${(average(data, "gewicht")).toFixed(2)}`);
  doc.text(`- Bandgeschwindigkeit (m/s): Ø ${(average(data, "bandgeschwindigkeit")).toFixed(2)}`);
  doc.text(`- Korrekturfaktor: Ø ${(average(data, "korrekturfaktor")).toFixed(2)}`);
  doc.text(`- Total Gewicht (t): Δ ${diff("total_weight")}`);
  doc.text(`- Running Total (t): Δ ${diff("running_total")}`);
  doc.moveDown();

  doc.text("➤ Einzelwerte:");
  data.slice(0, 50).forEach((e) => {
    doc.text(`${e.timestamp} - Gewicht: ${e.gewicht} kg | Band: ${e.bandgeschwindigkeit} m/s`);
  });

  doc.end();

  const buffers = [];
  for await (const chunk of bufferStream) {
    buffers.push(chunk);
  }

  return Buffer.concat(buffers);
}

// 📧 E-MAIL VERSAND
async function sendReportEmail() {
  console.log("📤 Sende PDF an:", emailSettings.email);
  await client.connect();
  const daten = await client
    .db("pklose")
    .collection("messwerte")
    .find({})
    .sort({ timestamp: -1 })
    .limit(1000)
    .toArray();

  const pdfBuffer = await generatePDF(daten.reverse());

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER, // z. B. render env var
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"IoT Dashboard" <${process.env.EMAIL_USER}>`,
    to: emailSettings.email,
    subject: "📈 IoT Waagen Report",
    text: "Im Anhang findest du den automatisierten PDF-Bericht.",
    attachments: [{
      filename: "bericht.pdf",
      content: pdfBuffer,
      contentType: "application/pdf",
    }],
  });

  console.log("✅ Bericht gesendet.");
}

// 🌐 Start
app.listen(10000, () => {
  console.log("API läuft auf Port 10000");
});

// 📊 Hilfsfunktion Durchschnitt
function average(data, field) {
  if (!data.length) return 0;
  return data.reduce((sum, e) => sum + parseFloat(e[field] || 0), 0) / data.length;
}
