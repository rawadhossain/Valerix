import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = process.env.PORT || 8080;

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';

app.use(cors());

// Proxy Options
const proxyOptions = {
    changeOrigin: true,
    pathRewrite: {
        '^/api/orders': '/orders',
        '^/api/products': '/products',
        '^/api/inventory': '/inventory',
    },
    timeout: 10000,
    proxyTimeout: 10000
};

// Routes
// Forward /api/orders to Order Service
app.use('/api/orders', createProxyMiddleware({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/orders': '/orders' }
}));

// Forward /api/products to Inventory Service
app.use('/api/products', createProxyMiddleware({
    target: INVENTORY_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/products': '/products' }
}));

// Forward /api/inventory/deduct to Inventory Service (if needed directly)
app.use('/api/inventory', createProxyMiddleware({
    target: INVENTORY_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/inventory': '/inventory' }
}));

// Service Health Checks
app.use('/api/health/orders', createProxyMiddleware({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/health/orders': '/health' }
}));

app.use('/api/health/inventory', createProxyMiddleware({
    target: INVENTORY_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/health/inventory': '/health' }
}));

// Service Metrics
app.use('/api/metrics/orders', createProxyMiddleware({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/metrics/orders': '/metrics' }
}));

app.use('/api/metrics/inventory', createProxyMiddleware({
    target: INVENTORY_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/metrics/inventory': '/metrics' }
}));

// Service Stats (Custom)
app.use('/api/stats/orders', createProxyMiddleware({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/stats/orders': '/stats' }
}));

app.get('/health', (req, res) => {
    res.json({ status: 'API Gateway UP' });
});

app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
});
