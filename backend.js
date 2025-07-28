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
  doc.fontSize(12).text(`Bericht erstellt am: ${new Date().toLocaleString("de-DE")}`);
  doc.moveDown();

  if (!data || data.length === 0) {
    doc.text("⚠️ Keine Daten für diesen Zeitraum verfügbar.");
    doc.end();
    const buffers = [];
    for await (const chunk of bufferStream) buffers.push(chunk);
    return Buffer.concat(buffers);
  }

  const first = data[0];
  const last = data[data.length - 1];

  // Hilfsfunktion zur Auswertung eines Felds
  function stats(field) {
    const values = data.map(e => parseFloat(e[field] || 0)).filter(v => !isNaN(v));
    if (values.length === 0) return null;
    return {
      first: values[0],
      last: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }

  // Felder mit Einheit
  const fields = [
    { label: "Gewicht", field: "gewicht", unit: "kg" },
    { label: "Bandgeschwindigkeit", field: "bandgeschwindigkeit", unit: "m/s" },
    { label: "Korrekturfaktor", field: "korrekturfaktor", unit: "" },
    { label: "Tageszähler", field: "total_weight", unit: "t" },
    { label: "Running Total", field: "running_total", unit: "t" },
  ];

  fields.forEach(({ label, field, unit }) => {
    const s = stats(field);
    if (!s) {
      doc.text(`➤ ${label}: Keine gültigen Daten.`);
    } else {
      doc.text(`➤ ${label}:`);
      doc.text(`   Start: ${s.first.toFixed(2)} ${unit}, Ende: ${s.last.toFixed(2)} ${unit}`);
      doc.text(`   Min: ${s.min.toFixed(2)}, Max: ${s.max.toFixed(2)}, Ø: ${s.avg.toFixed(2)} ${unit}`);
    }
    doc.moveDown(0.5);
  });

  // Sonderfall Förderleistung (berechnet)
  const leistungen = data.map(e =>
    parseFloat(e.gewicht || 0) *
    parseFloat(e.bandgeschwindigkeit || 0) *
    parseFloat(e.korrekturfaktor || 1) *
    3.6
  ).filter(v => !isNaN(v));

  if (leistungen.length > 0) {
    const leistungStats = {
      first: leistungen[0],
      last: leistungen[leistungen.length - 1],
      min: Math.min(...leistungen),
      max: Math.max(...leistungen),
      avg: leistungen.reduce((a, b) => a + b, 0) / leistungen.length,
    };

    doc.text(`➤ Förderleistung (t/h):`);
    doc.text(`   Start: ${leistungStats.first.toFixed(2)}, Ende: ${leistungStats.last.toFixed(2)}`);
    doc.text(`   Min: ${leistungStats.min.toFixed(2)}, Max: ${leistungStats.max.toFixed(2)}, Ø: ${leistungStats.avg.toFixed(2)} t/h`);
  } else {
    doc.text(`➤ Förderleistung: Keine gültigen Werte berechenbar.`);
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
  try {
    const iso = e.timestamp.replace(" ", "T");
    const parsed = new Date(iso);
    return parsed instanceof Date && !isNaN(parsed) && parsed >= cutoff;
  } catch {
    return false;
  }
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
