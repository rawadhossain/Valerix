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
    // view state: 'dashboard' | 'metrics'
    const [view, setView] = useState('dashboard');

    // Dashboard State
    const [loading, setLoading] = useState(false);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [latency, setLatency] = useState<number | null>(null);
    const [health, setHealth] = useState<{ order: string, inventory: string }>({ order: 'CHECKING', inventory: 'CHECKING' });
    const [avgLatency, setAvgLatency] = useState<number>(0);

    const addLog = (msg: string) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

    // Data Fetching
    const checkHealth = async () => {
        try {
            await axios.get(`${API_GATEWAY_URL}/health/orders`);
            setHealth(prev => ({ ...prev, order: 'UP' }));
        } catch { setHealth(prev => ({ ...prev, order: 'DOWN' })); }

        try {
            await axios.get(`${API_GATEWAY_URL}/health/inventory`);
            setHealth(prev => ({ ...prev, inventory: 'UP' }));
        } catch { setHealth(prev => ({ ...prev, inventory: 'DOWN' })); }
    };

    const fetchStats = async () => {
        try {
            const res = await axios.get(`${API_GATEWAY_URL}/stats/orders`);
            setAvgLatency(res.data.averageLatency);
        } catch { console.error("Stats fetch failed"); }
    };

    const fetchProducts = async (initializeSelection = false) => {
        try {
            const res = await axios.get(`${API_GATEWAY_URL}/products`);
            setProducts(res.data);
            if (initializeSelection && res.data.length > 0 && !selectedProduct) {
                setSelectedProduct(res.data[0].id);
            }
        } catch (e) { addLog(`⚠️ Failed to fetch products: ${e}`); }
    };

    // Initial Load & Polling
    useEffect(() => {
        const init = async () => {
            await checkHealth();
            await fetchProducts(true);
            fetchStats();
        };
        init();

        const interval = setInterval(() => {
            checkHealth();
            fetchProducts(false);
            fetchStats();
        }, 5000); // 5s poll for health/stock

        const statsInterval = setInterval(fetchStats, 2000); // 2s poll for smooth stats

        return () => { clearInterval(interval); clearInterval(statsInterval); };
    }, []);

    // Async Order Polling
    const [queuedOrderIds, setQueuedOrderIds] = useState<string[]>([]);
    useEffect(() => {
        if (queuedOrderIds.length === 0) return;
        const pollInterval = setInterval(async () => {
            try {
                const res = await axios.get(`${API_GATEWAY_URL}/orders`); // In prod, use specific ID endpoint
                const orders = res.data;
                const remaining = queuedOrderIds.filter(id => {
                    const order = orders.find((o: any) => o.id === id);
                    if (order?.status === 'COMPLETED') {
                        addLog(`✅ Async Order Completed! ID: ${id.substring(0, 8)}...`);
                        fetchProducts();
                        return false;
                    }
                    if (order?.status === 'FAILED') return false;
                    return true;
                });
                if (remaining.length !== queuedOrderIds.length) setQueuedOrderIds(remaining);
            } catch (e) { console.error("Polling error", e); }
        }, 2000);
        return () => clearInterval(pollInterval);
    }, [queuedOrderIds]);

    // Action
    const placeOrder = async (isGremlin: boolean) => {
        if (!selectedProduct) return;
        setLoading(true);
        const start = performance.now();
        addLog(`Initiating Order... (Gremlin: ${isGremlin ? 'ON' : 'OFF'})`);

        try {
            const res = await axios.post(`${API_GATEWAY_URL}/orders`, {
                productId: selectedProduct,
                quantity: 1,
                gremlin: isGremlin
            });
            const dur = Math.round(performance.now() - start);
            setLatency(dur);

            if (res.status === 202) {
                addLog(`⚠️ Order Queued (Timeout). Duration: ${dur}ms`);
                setQueuedOrderIds(prev => [...prev, res.data.id]);
            } else {
                addLog(`✅ Order Success! Duration: ${dur}ms`);
                fetchProducts();
            }
        } catch (error: any) {
            const dur = Math.round(performance.now() - start);
            setLatency(dur);
            addLog(`❌ Failed: ${error.response?.data?.error || error.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <div className="header">
                <h1>Valerix</h1>
                <div className="nav-buttons">
                    <button className={`nav-btn ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>Dashboard</button>
                    <button className={`nav-btn ${view === 'metrics' ? 'active' : ''}`} onClick={() => setView('metrics')}>Metrics</button>
                    <a href="http://localhost:3003/dashboards" target="_blank" rel="noopener noreferrer">
                        <button className="nav-btn">Grafana ↗</button>
                    </a>
                </div>
            </div>

            {view === 'dashboard' ? (
                <>
                    <div className="stats-grid">
                        <div className="stat-card">
                            <span className="stat-label">Order Service</span>
                            <div className="status-indicator">
                                <span className={`dot ${health.order === 'UP' ? 'green' : 'red'}`}></span>
                                {health.order}
                            </div>
                        </div>
                        <div className="stat-card">
                            <span className="stat-label">Inventory Service</span>
                            <div className="status-indicator">
                                <span className={`dot ${health.inventory === 'UP' ? 'green' : 'red'}`}></span>
                                {health.inventory}
                            </div>
                        </div>
                        <div className="stat-card" style={{ borderColor: avgLatency > 0.1 ? 'var(--danger)' : 'var(--card-border)' }}>
                            <span className="stat-label">Avg Latency (30s)</span>
                            <span className="stat-value" style={{ color: avgLatency > 0.1 ? 'var(--danger)' : 'var(--success)' }}>
                                {avgLatency.toFixed(3)}s
                            </span>
                        </div>
                    </div>

                    <div className="main-card">
                        <h2>Order Simulation</h2>
                        <div style={{ marginBottom: '2rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.8rem', color: '#a1a1aa', fontSize: '0.9rem' }}>Select Product</label>
                            <select value={selectedProduct} onChange={(e) => setSelectedProduct(e.target.value)}>
                                {products.map(p => (
                                    <option key={p.id} value={p.id}>{p.name} — {p.stock} in stock</option>
                                ))}
                            </select>
                        </div>

                        <div className="latency-display">
                            <div className="latency-value" style={{
                                color: latency !== null ? (latency > 2000 ? '#eab308' : latency > 1000 ? '#ef4444' : '#22c55e') : '#2f2f35'
                            }}>
                                {latency !== null ? `${latency}ms` : '---'}
                            </div>
                            <div className="latency-label">Request Latency</div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
                            <button className="btn-primary" onClick={() => placeOrder(false)} disabled={loading || !selectedProduct}>
                                🚀 Place Order
                            </button>
                            <button className="btn-danger" onClick={() => placeOrder(true)} disabled={loading || !selectedProduct}>
                                🐢 Trigger Gremlin
                            </button>
                        </div>
                    </div>

                    <div className="logs-panel">
                        <h3 style={{ position: 'sticky', top: 0, background: '#000', paddingBottom: '0.5rem', borderBottom: '1px solid #333' }}>System Activity</h3>
                        {logs.map((log, i) => <div key={i} className="log-entry">{log}</div>)}
                    </div>
                </>
            ) : (
                <MetricsPage />
            )}
        </>
    );
}

const MetricsPage = () => {
    const [orderMetrics, setOrderMetrics] = useState<string>('');
    const [inventoryMetrics, setInventoryMetrics] = useState<string>('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetch = async () => {
            try {
                const [res1, res2] = await Promise.all([
                    axios.get(`${API_GATEWAY_URL}/metrics/orders`),
                    axios.get(`${API_GATEWAY_URL}/metrics/inventory`)
                ]);
                setOrderMetrics(res1.data);
                setInventoryMetrics(res2.data);
            } catch (e: any) {
                console.error("Metrics fetch failed", e);
            } finally {
                setLoading(false);
            }
        };
        fetch();
        const interval = setInterval(fetch, 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="metrics-page">
            <h2 style={{ marginBottom: '2rem' }}>Service Health & Metrics</h2>
            {loading && <p style={{ color: '#a1a1aa' }}>Loading metrics...</p>}

            <ServiceMetricsViewer name="Order Service" rawData={orderMetrics} />
            <ServiceMetricsViewer name="Inventory Service" rawData={inventoryMetrics} />
        </div>
    );
};

const ServiceMetricsViewer = ({ name, rawData }: { name: string, rawData: string }) => {
    const [showRaw, setShowRaw] = useState(false);

    // Simple parsing helpers
    const getValue = (key: string) => {
        const match = rawData.match(new RegExp(`${key} ([0-9.]+)`));
        return match ? parseFloat(match[1]) : 0;
    };

    const cpu = getValue('process_cpu_user_seconds_total');
    const memory = getValue('process_resident_memory_bytes');
    const heap = getValue('nodejs_heap_size_used_bytes');
    const uptime = getValue('process_uptime_seconds');
    const handles = getValue('nodejs_active_handles');
    const lag = getValue('nodejs_eventloop_lag_seconds');

    const formatBytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

    return (
        <div className="metrics-section">
            <div className="metrics-header">
                <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)', margin: 0 }}>{name}</h3>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <span className="dot green"></span>
                    <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>UP {Math.floor(uptime / 60)}m</span>
                </div>
            </div>

            <div className="key-metrics-grid">
                <div className="metric-item">
                    <span className="label">Memory (RSS)</span>
                    <div className="value">{formatBytes(memory)}<span className="unit">MB</span></div>
                </div>
                <div className="metric-item">
                    <span className="label">Heap Used</span>
                    <div className="value">{formatBytes(heap)}<span className="unit">MB</span></div>
                </div>
                <div className="metric-item">
                    <span className="label">CPU Used</span>
                    <div className="value">{cpu.toFixed(2)}<span className="unit">s</span></div>
                </div>
                <div className="metric-item">
                    <span className="label">Active Handles</span>
                    <div className="value">{handles}</div>
                </div>
                <div className="metric-item">
                    <span className="label">Event Loop Lag</span>
                    <div className="value">{lag.toFixed(4)}<span className="unit">s</span></div>
                </div>
            </div>

            <button className="raw-toggle" onClick={() => setShowRaw(!showRaw)}>
                {showRaw ? 'Hide Raw Data' : 'View Raw Prometheus Data'}
            </button>

            {showRaw && <div className="metric-box">{rawData}</div>}
        </div>
    );
};

export default App
