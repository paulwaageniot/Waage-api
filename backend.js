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
  interval: "daily",
};

let thresholdSettings = {
  gewicht: 100,
  band: 2,
  leistung: 600,
  korrektur: true,
};
let lastKorrekturfaktor = null;

// 📩 Grenzwerte vom Frontend empfangen
app.post("/thresholds", (req, res) => {
  const { gewicht, band, leistung, korrektur } = req.body;
  thresholdSettings = { gewicht, band, leistung, korrektur };
  console.log("🔧 Neue Grenzwerte:", thresholdSettings);
  res.send("✅ Grenzwerte gespeichert");
});

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

// 📄 PDF GENERIEREN
async function generatePDF(data, label = "Automatischer Bericht", daysBack = 1) {
  const doc = new PDFDocument();
  const bufferStream = new stream.PassThrough();
  doc.pipe(bufferStream);

  doc.fontSize(18).text(label, { align: "center" });
  doc.moveDown();

  const createdAt = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
  doc.fontSize(12).text(`Bericht erstellt am: ${createdAt}`);
  doc.text(`Zeitraum: Letzte ${daysBack} Tage`);
  doc.moveDown();
  if (!data || data.length === 0) {
    doc.text("Keine Daten für diesen Zeitraum verfügbar.");
    doc.end();
    const buffers = [];
    for await (const chunk of bufferStream) buffers.push(chunk);
    return Buffer.concat(buffers);
  }

  const fields = [
    { label: "Gewicht", field: "gewicht", unit: "kg" },
    { label: "Bandgeschwindigkeit", field: "bandgeschwindigkeit", unit: "m/s" },
    { label: "Korrekturfaktor", field: "korrekturfaktor", unit: "" },
    { label: "Tageszähler", field: "total_weight", unit: "t" },
    { label: "Running Total", field: "running_total", unit: "t" },
  ];

  const getStats = (values) => {
    if (!values.length) return null;
    return {
      first: values[0],
      last: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  };

  for (const { label, field, unit } of fields) {
    const values = data.map(e => parseFloat(e[field] || 0)).filter(v => !isNaN(v));
    const stats = getStats(values);
    if (!stats) {
      doc.text(`- ${label}: Keine gültigen Daten.`);
    } else {
      doc.text(`- ${label}:`);
      doc.text(`   Start: ${stats.first.toFixed(2)} ${unit}, Ende: ${stats.last.toFixed(2)} ${unit}`);
      doc.text(`   Min: ${stats.min.toFixed(2)}, Max: ${stats.max.toFixed(2)}, Ø: ${stats.avg.toFixed(2)} ${unit}`);
    }
    doc.moveDown(0.5);
  }

  // Förderleistung
  const leistungen = data.map(e =>
    parseFloat(e.gewicht || 0) *
    parseFloat(e.bandgeschwindigkeit || 0) *
    parseFloat(e.korrekturfaktor || 1) *
    3.6
  ).filter(v => !isNaN(v));

  const leistungStats = getStats(leistungen);
  if (!leistungStats) {
    doc.text("- Förderleistung: Keine gültigen Werte berechenbar.");
  } else {
    doc.text("- Förderleistung (t/h):");
    doc.text(`   Start: ${leistungStats.first.toFixed(2)}, Ende: ${leistungStats.last.toFixed(2)}`);
    doc.text(`   Min: ${leistungStats.min.toFixed(2)}, Max: ${leistungStats.max.toFixed(2)}, Ø: ${leistungStats.avg.toFixed(2)} t/h`);
  }

  doc.end();
  const buffers = [];
  for await (const chunk of bufferStream) buffers.push(chunk);
  return Buffer.concat(buffers);
}

function generateCSV(data) {
  if (!data || data.length === 0) return Buffer.from("Keine Daten verfügbar.");

  const fields = ["timestamp", "gewicht", "bandgeschwindigkeit", "korrekturfaktor", "total_weight", "running_total"];
  const header = fields.join(";") + "\n";

  const rows = data.map(e =>
    fields.map(f => e[f] !== undefined ? e[f] : "").join(";")
  ).join("\n");

  return Buffer.from(header + rows, "utf-8");
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

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - daysBack);

  const filtered = daten.reverse().filter(e => {
    try {
      const parsed = new Date(e.timestamp.replace(" ", "T"));
      return parsed >= cutoff;
    } catch {
      return false;
    }
  });

  const pdfBuffer = await generatePDF(filtered, label, daysBack);
  const csvBuffer = generateCSV(filtered);

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
    text: "Im Anhang findest du deinen PDF- und CSV-Bericht.",
    attachments: [
      { filename: "Waagenreport.pdf", content: pdfBuffer },
      { filename: "Waagendaten.csv", content: csvBuffer },
    ],
  });

  console.log(`✅ ${label} gesendet an ${emailSettings.email}`);
}

// 🔔 Grenzwertprüfung und Alarmierung
async function checkThresholdsAndNotify() {
  await client.connect();
  const daten = await client
    .db("pklose")
    .collection("messwerte")
    .find({})
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();

  if (!daten.length) return;

  const e = daten[0];
  const alerts = [];

  const gewicht = parseFloat(e.gewicht || 0);
  const band = parseFloat(e.bandgeschwindigkeit || 0);
  const korrektur = parseFloat(e.korrekturfaktor || 1);
  const leistung = gewicht * band * korrektur * 3.6;

  if (gewicht > thresholdSettings.gewicht) alerts.push(`⚠️ Gewicht > ${thresholdSettings.gewicht} kg: ${gewicht}`);
  if (band > thresholdSettings.band) alerts.push(`⚠️ Bandgeschwindigkeit > ${thresholdSettings.band} m/s: ${band}`);
  if (leistung > thresholdSettings.leistung) alerts.push(`⚠️ Förderleistung > ${thresholdSettings.leistung} t/h: ${leistung.toFixed(2)}`);

  if (
    thresholdSettings.korrektur &&
    lastKorrekturfaktor !== null &&
    korrektur !== lastKorrekturfaktor
  ) {
    alerts.push(`⚠️ Korrekturfaktor geändert: ${lastKorrekturfaktor} ➜ ${korrektur}`);
  }

  lastKorrekturfaktor = korrektur;

  if (alerts.length) {
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
      subject: "🚨 Grenzwert Alarm",
      text: alerts.join("\n"),
    });

    console.log("🚨 Grenzwert-Mail gesendet.");
  }
}

// ⏰ CRON-JOBS
cron.schedule("0 8 * * *", () => {
  if (emailSettings.interval === "daily") sendReportEmail("Täglicher Bericht", 1);
});
cron.schedule("0 8 * * 1", () => {
  if (emailSettings.interval === "weekly") sendReportEmail("Wöchentlicher Bericht", 7);
});
cron.schedule("0 8 1 * *", () => {
  if (emailSettings.interval === "monthly") sendReportEmail("Monatsbericht", 30);
});
cron.schedule("*/10 * * * *", () => {
  if (emailSettings.email) checkThresholdsAndNotify();
});

// 🖱️ MANUELL SENDEN
app.post("/send-now", async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 1;
    await sendReportEmail("Manuell gesendeter Bericht", days);
    res.send("✅ Bericht manuell gesendet");
  } catch (err) {
    console.error(err);
    res.status(500).send(" Fehler beim Senden");
  }
});

app.listen(10000, () => console.log("🚀 API läuft auf Port 10000"));
