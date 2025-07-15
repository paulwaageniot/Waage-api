const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());

const uri = 'mongodb+srv://pklose:Start123456@iotcluster.ifvtvb3.mongodb.net/?retryWrites=true&w=majority&appName=IoTCluster';
const client = new MongoClient(uri);

app.get('/data', async (req, res) => {
  try {
    await client.connect();
    const daten = await client
      .db('pklose')
      .collection('messwerte')
      .find({})
      .sort({ timestamp: -1 })
      .limit(1000)
      .toArray();
    res.json(daten.reverse());
  } catch (e) {
    res.status(500).send('Fehler beim Abrufen');
  }
});
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`API läuft auf Port ${PORT}`);
});

