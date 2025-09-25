const express = require('express');
const app     = express();
const PORT = process.env.PORT || 3001;

app.get('/',(req, res) => {
	res.send('Ol ! App rodando');
	});

app.get('/health', (req, res) => {
	res.json({ status: 'ok', time:new Date().toISOString() });
	});

app.listen(PORT, () => {
	console.log(`Servidor escutando na porta ${PORT}`);
});
