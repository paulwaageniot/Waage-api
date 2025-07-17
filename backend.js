const express = require('express');
const basicAuth = require('express-basic-auth'); // Zugriffsschutz
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());

// 🔐 Authentifizierung (Benutzername & Passwort)
app.use(basicAuth({
  users: { 'paul': 'Start123' },  // <== HIER Benutzer & Passwort ändern
  challenge: true,
  realm: 'MTS Dashboard'
}));

// 🌐 MongoDB-Verbindung
const uri = 'mongodb+srv://pklose:Start123456@iotcluster.ifvtvb3.mongodb.net/?retryWrites=true&w=majority&appName=IoTCluster';
const client = new MongoClient(uri);

// 📦 API-Endpunkt: /data
app.get('/data', async (req, res) => {
  try {
    await client.connect();
    const daten = await client
      .db('pklose')                    // <== ggf. Datenbanknamen prüfen
      .collection('messwerte')
      .find({})
      .sort({ timestamp: -1 })
      .limit(1000)
      .toArray();
    res.json(daten.reverse()); // neueste Daten zuletzt
  } catch (e) {
    res.status(500).send('Fehler beim Abrufen');
  }
});

// 🟢 Server starten
app.listen(10000, () => {
  console.log('API läuft auf Port 10000');
});

