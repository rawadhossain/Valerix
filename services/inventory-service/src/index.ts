import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import client from 'prom-client';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Prometheus Metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });
app.get('/metrics', async (req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
});

// Health Check
app.get('/health', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.status(200).json({ status: 'UP', db: 'CONNECTED' });
    } catch (error) {
        res.status(503).json({ status: 'DOWN', db: 'DISCONNECTED' });
    }
});

// Seed Products (Internal function)
const seedProducts = async () => {
    try {
        const count = await prisma.product.count();
        if (count === 0) {
            console.log("Seeding products...");
            await prisma.product.createMany({
                data: [
                    { name: 'Quantum Processor', stock: 100 },
                    { name: 'Neural Interface', stock: 50 },
                    { name: 'Flux Capacitor', stock: 20 },
                    { name: 'Hyperdrive Unit', stock: 10 }
                ]
            });
            console.log("Seeding complete.");
        }
    } catch (e) {
        console.error("Seeding failed:", e);
    }
};

// Seed Endpoint (Manual trigger if needed)
app.post('/seed', async (req, res) => {
    await seedProducts();
    res.json({ message: 'Seeding check complete' });
});

// Get all products
app.get('/products', async (req, res) => {
    const products = await prisma.product.findMany({ orderBy: { name: 'asc' } });
    res.json(products);
});

// Deduct Inventory (with Idempotency + Gremlin Latency)
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://user:password@rabbitmq:5672';
let channel: any;

// Connect to RabbitMQ
// Connect to RabbitMQ
async function connectToRabbit() {
    const amqp = require('amqplib');
    while (true) {
        try {
            const connection = await amqp.connect(RABBITMQ_URL);
            channel = await connection.createChannel();
            await channel.assertQueue('inventory_queue');
            await channel.assertQueue('order_completion_queue');

            console.log("Connected to RabbitMQ & listening on inventory_queue");

            channel.consume('inventory_queue', async (msg: any) => {
                if (msg !== null) {
                    const data = JSON.parse(msg.content.toString());
                    console.log("Received Async Order via RabbitMQ:", data);

                    try {
                        await deductInventory(data.productId, data.quantity, data.orderId);

                        // Send Completion Event
                        const completionMsg = JSON.stringify({
                            orderId: data.orderId,
                            status: 'COMPLETED',
                            message: 'Inventory deducted successfully (Async)'
                        });
                        channel.sendToQueue('order_completion_queue', Buffer.from(completionMsg));
                        console.log("Sent completion event for:", data.orderId);

                        channel.ack(msg);
                    } catch (e: any) {
                        console.error("Async Processing Failed:", e.message);
                        channel.ack(msg);
                    }
                }
            });
            break; // Success
        } catch (e) {
            console.error("RabbitMQ Connection Failed, retrying in 5s...", e);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Logic: Deduct Inventory
async function deductInventory(productId: string, quantity: number, orderId: string) {
    const existingLog = await prisma.idempotencyLog.findUnique({
        where: { orderId }
    });

    if (existingLog) {
        console.log(`Idempotency check: Order ${orderId} already processed.`);
        return { message: 'Stock already deducted (Idempotent)', success: true };
    }

    await prisma.$transaction(async (tx) => {
        const product = await tx.product.findUnique({ where: { id: productId } });
        if (!product || product.stock < quantity) {
            throw new Error('Insufficient stock or product not found');
        }

        await tx.product.update({
            where: { id: productId },
            data: { stock: product.stock - quantity }
        });

        await tx.idempotencyLog.create({
            data: { orderId }
        });
    });

    return { message: 'Stock deducted', success: true };
}

// Deduct Inventory Endpoint
app.post('/inventory/deduct', async (req: Request, res: Response) => {
    const { productId, quantity, orderId } = req.body;

    if (!productId || !quantity || !orderId) {
        res.status(400).json({ error: 'Missing productId, quantity, or orderId' });
        return;
    }

    try {
        // Gremlin Latency: Simulate "Not Responding" / High Latency
        // This will cause the synchronous caller (Order Service) to timeout.
        // Gremlin Latency: Simulate "Not Responding" / High Latency
        if (req.body.gremlin === true) {
            console.log("Gremlin Triggered: Delaying response...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        const result = await deductInventory(productId, quantity, orderId);
        res.status(200).json(result);

    } catch (error: any) {
        console.error("Inventory Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

app.listen(PORT, async () => {
    console.log(`Inventory Service running on port ${PORT}`);
    await seedProducts();
    await connectToRabbit();
});
