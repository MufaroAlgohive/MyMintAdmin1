require('dotenv').config();
const { fetchSupabaseJson } = require('./api/_orderbook.js');
fetchSupabaseJson('/rest/v1/investor_trade_confirmations?limit=1').then(console.log).catch(console.error);
