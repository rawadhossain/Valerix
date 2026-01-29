import { useState, useEffect } from 'react'
import axios from 'axios'
import './index.css'

const API_GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL || 'http://localhost:8080/api';

interface Product {
    id: string;
    name: string;
    stock: number;
}

function App() {
    const [loading, setLoading] = useState(false);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [latency, setLatency] = useState<number | null>(null);
    const [health, setHealth] = useState<{ order: string }>({ order: 'CHECKING' });

    const addLog = (msg: string) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

    const checkHealth = async () => {
        try {
            await axios.get(`${API_GATEWAY_URL}/health/orders`);
            setHealth({ order: 'UP' });
        } catch (e) {
            setHealth({ order: 'DOWN' });
        }
    };

    const fetchProducts = async (initializeSelection = false) => {
        try {
            const res = await axios.get(`${API_GATEWAY_URL}/products`);
            setProducts(res.data);
            if (initializeSelection && res.data.length > 0 && !selectedProduct) {
                setSelectedProduct(res.data[0].id);
            }
        } catch (e) {
            addLog(`⚠️ Failed to fetch products: ${e}`);
        }
    };

    useEffect(() => {
        checkHealth();
        fetchProducts(true);
        const interval = setInterval(() => {
            checkHealth();
            fetchProducts(false); // Refresh stock levels without resetting selection
        }, 5000);
        return () => clearInterval(interval);
    }, []);

    const [avgLatency, setAvgLatency] = useState<number>(0);

    useEffect(() => {
        const statsInterval = setInterval(async () => {
            try {
                const res = await axios.get(`${API_GATEWAY_URL}/stats/orders`);
                setAvgLatency(res.data.averageLatency);
            } catch (e) {
                console.error("Failed to fetch stats");
            }
        }, 2000);
        return () => clearInterval(statsInterval);
    }, []);

    const [queuedOrderIds, setQueuedOrderIds] = useState<string[]>([]);

    useEffect(() => {
        if (queuedOrderIds.length === 0) return;

        const pollInterval = setInterval(async () => {
            try {
                const res = await axios.get(`${API_GATEWAY_URL}/orders`);
                const orders = res.data;

                // Check status of all queued orders
                const remainingQueuedIds = queuedOrderIds.filter(id => {
                    const order = orders.find((o: any) => o.id === id);
                    if (order && order.status === 'COMPLETED') {
                        addLog(`✅ Async Order Completed! ID: ${id}`);
                        fetchProducts(); // Refresh stock
                        return false; // Remove from queued list
                    }
                    if (order && order.status === 'FAILED') {
                        addLog(`❌ Async Order Failed! ID: ${id}`);
                        return false; // Remove from queued list
                    }
                    return true; // Keep polling
                });

                if (remainingQueuedIds.length !== queuedOrderIds.length) {
                    setQueuedOrderIds(remainingQueuedIds);
                }

            } catch (e) {
                console.error("Polling error", e);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [queuedOrderIds]);

    const placeOrder = async (isGremlin: boolean) => {
        if (!selectedProduct) {
            addLog("⚠️ No product selected!");
            return;
        }

        setLoading(true);
        const start = performance.now();
        addLog(`Initiating Order... (Product: ${products.find(p => p.id === selectedProduct)?.name}, Gremlin: ${isGremlin ? 'ON' : 'OFF'})`);

        try {
            // Send 'gremlin' flag to trigger latency in Inventory Service
            const quantity = 1;
            const response = await axios.post(`${API_GATEWAY_URL}/orders`, {
                productId: selectedProduct,
                quantity,
                gremlin: isGremlin
            });

            const end = performance.now();
            const dur = Math.round(end - start);
            setLatency(dur);

            if (response.status === 202) {
                // QUEUED
                addLog(`⚠️ Order Queued: ${response.data.message}. Duration: ${dur}ms`);

                // Poll for completion
                const orderId = response.data.id;
                const pollInterval = setInterval(async () => {
                    try {
                        const pollRes = await axios.get(`${API_GATEWAY_URL}/orders`);
                        // Ideally we'd have a specific GET /orders/:id endpoint, but filtering list works for demo
                        const myOrder = pollRes.data.find((o: any) => o.id === orderId);
                        if (myOrder && myOrder.status === 'COMPLETED') {
                            addLog(`✅ Async Order Completed! ID: ${orderId}`);
                            clearInterval(pollInterval);
                            fetchProducts();
                        }
                    } catch (e) {
                        console.error("Polling error", e);
                    }
                }, 2000);

            } else {
                // SUCCESS
                addLog(`✅ Order Success! ID: ${response.data.id}. Duration: ${dur}ms`);
                fetchProducts(); // Update stock immediately
            }

        } catch (error: any) {
            const end = performance.now();
            const dur = Math.round(end - start);
            setLatency(dur);

            const errMsg = error.response?.data?.error || error.message;
            addLog(`❌ Order Failed: ${errMsg}. Duration: ${dur}ms`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <h1>Valerix</h1>

            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '2rem' }}>
                <div className={`status-badge ${health.order === 'UP' ? 'CONFIRMED' : 'FAILED'}`}>
                    Order Service: {health.order}
                </div>
                <div className={`status-badge`} style={{
                    backgroundColor: avgLatency > 0.1 ? 'var(--danger)' : 'var(--success)',
                    color: 'white',
                    transition: 'background-color 0.3s'
                }}>
                    Avg Latency (30s): {avgLatency.toFixed(2)}s
                </div>
            </div>

            <div className="card">
                <h2>Order Simulation</h2>
                <p style={{ color: '#8b949e', marginBottom: '1.5rem' }}>
                    Select a product and test resilience patterns.
                </p>

                <div style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Select Product:</label>
                    <select
                        style={{
                            padding: '10px',
                            borderRadius: '5px',
                            backgroundColor: '#0d1117',
                            color: 'white',
                            border: '1px solid #30363d',
                            fontSize: '1rem',
                            minWidth: '200px'
                        }}
                        value={selectedProduct}
                        onChange={(e) => setSelectedProduct(e.target.value)}
                    >
                        {products.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.name} (Stock: {p.stock})
                            </option>
                        ))}
                    </select>
                </div>

                <div style={{
                    fontSize: '2rem',
                    fontWeight: 'bold',
                    marginBottom: '1rem',
                    color: latency !== null ? (latency > 2000 ? '#e3b341' : latency > 1500 ? 'var(--danger)' : 'var(--success)') : 'inherit'
                }}>
                    {latency !== null ? (latency > 2000 ? 'QUEUED' : `${latency}ms`) : '---'}
                    <div style={{ fontSize: '0.8rem', color: '#8b949e', fontWeight: 'normal' }}>
                        {latency !== null && latency > 2000 ? 'Processed in Background' : 'Last Request Latency'}
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button onClick={() => placeOrder(false)} disabled={loading || !selectedProduct}>
                        🚀 Place Normal Order
                    </button>
                    <button className="danger" onClick={() => placeOrder(true)} disabled={loading || !selectedProduct}>
                        🐢 Trigger Gremlin (Latency)
                    </button>
                </div>
            </div>

            <div className="log-container">
                <h3>System Logs</h3>
                {logs.map((log, i) => <div key={i} style={{ borderBottom: '1px solid #333', padding: '4px 0' }}>{log}</div>)}
            </div>
        </>
    )
}

export default App
