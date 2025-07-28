const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const PDFDocument = require("pdfkit");
const stream = require("stream");
const multer = require("multer");
const upload = multer();

const app = express();
app.use(cors());
app.use(express.json());

const uri = "mongodb+srv://pklose:Start123456@iotcluster.ifvtvb3.mongodb.net/?retryWrites=true&w=majority&appName=IoTCluster";
const client = new MongoClient(uri);

let emailSettings = {
  email: "",
  interval: "daily",
};

app.post("/email-settings", (req, res) => {
  const { email, interval } = req.body;
  emailSettings = { email, interval };
  res.send("✅ E-Mail Einstellungen gespeichert");
});

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

// PDF-Generierung mit Randdaten (kein Screenshot)
async function generatePDF(data, label = "Automatischer Bericht") {
  const doc = new PDFDocument();
  const bufferStream = new stream.PassThrough();
  doc.pipe(bufferStream);

  doc.fontSize(18).text(label, { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Datum: ${new Date().toLocaleString("de-DE")}`);
  doc.moveDown();

  if (!data || data.length === 0) {
    doc.text("Keine Daten für diesen Zeitraum verfügbar.");
    doc.end();
    const buffers = [];
    for await (const chunk of bufferStream) buffers.push(chunk);
    return Buffer.concat(buffers);
  }

  function stats(field) {
    const values = data
      .map(e => parseFloat(e[field]))
      .filter(v => !isNaN(v));
    if (values.length === 0) return null;

    return {
      first: values[0],
      last: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }

  const fields = [
    { field: "gewicht", label: "Gewicht", unit: "kg" },
    { field: "bandgeschwindigkeit", label: "Bandgeschwindigkeit", unit: "m/s" },
    { field: "korrekturfaktor", label: "Korrekturfaktor", unit: "" },
    { field: "total_weight", label: "Tageszähler", unit: "t" },
    { field: "running_total", label: "Running Total", unit: "t" },
  ];

  fields.forEach(({ field, label, unit }) => {
    const s = stats(field);
    if (!s) {
      doc.text(`➤ ${label}: Keine gültigen Werte gefunden`);
    } else {
      doc.text(`➤ ${label}:`);
      doc.text(`   Start: ${s.first.toFixed(2)} ${unit}`);
      doc.text(`   Ende: ${s.last.toFixed(2)} ${unit}`);
      doc.text(`   Min: ${s.min.toFixed(2)}, Max: ${s.max.toFixed(2)}, Ø: ${s.avg.toFixed(2)} ${unit}`);
    }
    doc.moveDown(0.5);
  });

  // Förderleistung (extra berechnet)
  const leistungen = data
    .map(e => parseFloat(e.gewicht || 0) * parseFloat(e.bandgeschwindigkeit || 0) * parseFloat(e.korrekturfaktor || 1) * 3.6)
    .filter(v => !isNaN(v));

  if (leistungen.length === 0) {
    doc.text("➤ Förderleistung: Keine gültigen Werte berechenbar.");
  } else {
    doc.text(`➤ Förderleistung (t/h):`);
    doc.text(`   Start: ${leistungen[0].toFixed(2)}`);
    doc.text(`   Ende: ${leistungen[leistungen.length - 1].toFixed(2)}`);
    doc.text(`   Min: ${Math.min(...leistungen).toFixed(2)}, Max: ${Math.max(...leistungen).toFixed(2)}, Ø: ${(leistungen.reduce((a, b) => a + b, 0) / leistungen.length).toFixed(2)} t/h`);
  }

  doc.end();
  const buffers = [];
  for await (const chunk of bufferStream) buffers.push(chunk);
  return Buffer.concat(buffers);
}
async function sendReportEmail(label, daysBack) {
  await client.connect();
  const daten = await client
    .db("pklose")
    .collection("messwerte")
    .find({})
    .sort({ timestamp: -1 })
    .limit(1000)
    .toArray();
  const now = new Date();
  const cutoff = new Date();
  cutoff.setDate(now.getDate() - daysBack);


const filtered = daten.reverse().filter(e => {
  const [datePart, timePart] = e.timestamp.split(" ");
  const isoString = `${datePart}T${timePart}`;
  const ts = new Date(isoString);
  return !isNaN(ts) && ts >= cutoff;
});
  const pdfBuffer = await generatePDF(filtered, label);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"IoT Dashboard" <${process.env.EMAIL_USER}>`,
    to: emailSettings.email,
    subject: label,
    text: "Im Anhang findest du deinen PDF-Bericht.",
    attachments: [{ filename: "bericht.pdf", content: pdfBuffer }],
  });

  console.log(`📤 ${label} gesendet an ${emailSettings.email}`);
}

// ⏰ CRON-Jobs
cron.schedule("0 8 * * *", () => {
  if (emailSettings.interval === "daily") sendReportEmail("📩 Täglicher Bericht", 1);
});
cron.schedule("0 8 * * 1", () => {
  if (emailSettings.interval === "weekly") sendReportEmail("📩 Wöchentlicher Bericht", 7);
});
cron.schedule("0 8 1 * *", () => {
  if (emailSettings.interval === "monthly") sendReportEmail("📩 Monatsbericht", 30);
});

// 📬 Manuell senden ("Jetzt senden" Button)
app.post("/send-now", async (req, res) => {
  try {
    await sendReportEmail("📩 Manuell gesendeter Bericht", 1);
    res.send("✅ Bericht manuell gesendet");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Fehler beim Senden");
  }
});

app.listen(10000, () => console.log("🚀 API läuft auf Port 10000"));
