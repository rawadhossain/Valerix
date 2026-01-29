import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import cors from 'cors';
import client from 'prom-client';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://user:password@rabbitmq:5672';
let channel: any;

// Connect to RabbitMQ
async function connectToRabbit() {
    const amqp = require('amqplib');
    while (true) {
        try {
            const connection = await amqp.connect(RABBITMQ_URL);
            channel = await connection.createChannel();
            await channel.assertQueue('inventory_queue');
            await channel.assertQueue('order_completion_queue');
            console.log("Connected to RabbitMQ (Producer & Consumer)");

            // Listen for Completion Events
            channel.consume('order_completion_queue', async (msg: any) => {
                if (msg) {
                    const data = JSON.parse(msg.content.toString());
                    console.log(`Received Async Event: ${data.status} for Order ${data.orderId}`);

                    // Update Order Status in DB
                    try {
                        const status = (data.status === 'COMPLETED' || data.status === 'FAILED') ? data.status : 'COMPLETED';

                        await prisma.order.update({
                            where: { id: data.orderId },
                            data: { status: status }
                        });
                        console.log(`Order ${data.orderId} updated to ${status}`);
                    } catch (e) {
                        console.error("Failed to update order status:", e);
                    }

                    channel.ack(msg);
                }
            });
            break;
        } catch (e) {
            console.error("RabbitMQ Connection Failed, retrying in 5s...", e);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

app.use(cors());
app.use(express.json());

// Prometheus Metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDurationMicroseconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'code'],
    buckets: [0.1, 0.5, 1, 1.5, 2, 5]
});
register.registerMetric(httpRequestDurationMicroseconds);

app.use((req, res, next) => {
    const end = httpRequestDurationMicroseconds.startTimer();
    res.on('finish', () => {
        end({ method: req.method, route: req.path, code: res.statusCode });
    });
    next();
});

// Rolling Window Stats for Alerting
const WINDOW_SIZE_MS = 30000;
let requestDurations: { time: number, duration: number }[] = [];

// Periodic Cleanup
setInterval(() => {
    const now = Date.now();
    requestDurations = requestDurations.filter(r => now - r.time <= WINDOW_SIZE_MS);
}, 5000);

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = (Date.now() - start) / 1000; // in seconds
        requestDurations.push({ time: Date.now(), duration });
    });
    next();
});

// Stats Endpoint
app.get('/stats', (req, res) => {
    const now = Date.now();
    // Ensure we are looking at fresh data (though cleanup runs periodically)
    const validDurations = requestDurations.filter(r => now - r.time <= WINDOW_SIZE_MS);

    const count = validDurations.length;
    const totalDuration = validDurations.reduce((sum, r) => sum + r.duration, 0);
    const average = count > 0 ? totalDuration / count : 0;

    res.json({ averageLatency: average, requestCount: count });
});

// Health Check
app.get('/health', async (req: Request, res: Response) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.status(200).json({ status: 'UP', db: 'CONNECTED' });
    } catch (error) {
        res.status(503).json({ status: 'DOWN', db: 'DISCONNECTED' });
    }
});

// Metrics Endpoint
app.get('/metrics', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
});

// Get all orders
app.get('/orders', async (req: Request, res: Response) => {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(orders);
});

// Create Order (with Timeout handling)
app.post('/orders', async (req: Request, res: Response) => {
    const { productId, quantity, gremlin } = req.body;

    if (!productId || !quantity) {
        res.status(400).json({ error: 'Missing productId or quantity' });
        return;
    }

    // 1. Create Order (PENDING)
    const order = await prisma.order.create({
        data: {
            productId,
            quantity,
            status: 'PENDING'
        }
    });

    try {
        // 2. Call Inventory Service with Timeout
        // Requirement: return clear timeout error instead of freezing.
        // We set timeout to 2000ms (2s). If Inventory takes longer (Gremlin), we fail.
        const inventoryResponse = await axios.post(`${INVENTORY_SERVICE_URL}/inventory/deduct`, {
            productId,
            quantity,
            orderId: order.id, // For Idempotency
            gremlin
        }, {
            timeout: 2000
        });

        if (inventoryResponse.status === 200) {
            // 3. Update Order to CONFIRMED
            const updatedOrder = await prisma.order.update({
                where: { id: order.id },
                data: { status: 'CONFIRMED' }
            });
            res.status(201).json(updatedOrder);
        } else {
            throw new Error('Inventory deduction failed');
        }

    } catch (error: any) {
        console.error("Inventory call failed:", error.message);

        let errorMessage = 'Order failed due to inventory issue';
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            // TIMEOUT DETECTED -> Fallback to Async Queue
            console.log(`Order ${order.id} timed out. Queuing for background processing...`);

            try {
                if (channel) {
                    const msg = JSON.stringify({ productId, quantity, orderId: order.id });
                    channel.sendToQueue('inventory_queue', Buffer.from(msg));

                    // Update Order to QUEUED
                    const queuedOrder = await prisma.order.update({
                        where: { id: order.id },
                        data: { status: 'QUEUED' }
                    });

                    // Return QUEUED status to user
                    res.status(202).json({
                        message: 'Order timed out, queued for async processing',
                        status: 'QUEUED',
                        id: order.id
                    });
                    return;
                } else {
                    console.error("RabbitMQ channel not available");
                    throw new Error("Critical: Service Unavailable (Queue Down)");
                }
            } catch (queueError) {
                console.error("Queueing failed:", queueError);
                // Fallthrough to failure
            }
        }

        // General Failure
        // Update to FAILED
        await prisma.order.update({
            where: { id: order.id },
            data: { status: 'FAILED' }
        });

        res.status(503).json({ error: errorMessage, orderId: order.id, status: 'FAILED' });
    }
});

app.listen(PORT, async () => {
    console.log(`Order Service running on port ${PORT}`);
    await connectToRabbit();
});
