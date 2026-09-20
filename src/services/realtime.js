import { Server } from 'socket.io';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Socket.IO transport. Every backend event — monitoring sweeps, disruption
 * detection, workflow stages, bookings, hotel updates, notifications — is
 * broadcast from here so the browser never needs to poll or refresh.
 */
let io = null;
const log = logger.child('realtime');

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','), credentials: false },
    transports: ['websocket', 'polling'],
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    log.info(`client connected ${socket.id}`);
    socket.emit('system:hello', {
      message: 'TravelGuard realtime channel open',
      serverTime: new Date().toISOString(),
      env: config.env,
    });

    socket.on('trip:subscribe', (tripId) => {
      socket.join(`trip:${tripId}`);
      log.debug(`socket ${socket.id} subscribed to ${tripId}`);
    });

    socket.on('disconnect', (reason) => log.debug(`client disconnected ${socket.id} (${reason})`));
  });

  return io;
}

export function getIo() {
  return io;
}

export function emit(event, payload, room) {
  if (!io) return;
  if (room) io.to(room).emit(event, payload);
  else io.emit(event, payload);
}

export function emitToTrip(tripId, event, payload) {
  emit(event, payload, tripId ? [`trip:${tripId}`] : undefined);
}

/** Broadcast the authoritative trip + workflow state after any mutation. */
export function broadcastTripState({ trip, workflow }) {
  emit('trip:updated', { trip, workflow, at: new Date().toISOString() });
}

export function broadcastNotification(notification) {
  emit('notification:new', { notification, at: new Date().toISOString() });
}

export function broadcastAgentEvent(event) {
  emit('agent:event', { event, at: new Date().toISOString() });
}

export function broadcastStage(workflowId, stage, workflow) {
  emit('recovery:stage', { workflowId, stage, workflowSnapshot: summarise(workflow) });
}

export function broadcastWorkflow(workflow) {
  emit('recovery:workflow', { workflow });
}

export function broadcastMonitoring(payload) {
  emit('monitoring:tick', payload);
}

export function broadcastMetrics(metrics) {
  emit('metrics:updated', metrics);
}

const summarise = (workflow) =>
  workflow && {
    id: workflow.id,
    tripId: workflow.tripId,
    status: workflow.status,
    decision: workflow.decision?.decision,
    completedStages: workflow.stages.filter((s) => s.status === 'DONE').length,
    totalStages: workflow.stages.length,
  };
