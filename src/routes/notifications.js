import { Router } from 'express';
import { store } from '../domain/store.js';
import { notify } from '../services/notifications.js';
import { broadcastNotification } from '../services/realtime.js';
import { asyncHandler, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock } from '../utils/time.js';

export const notificationsRouter = Router();

/** GET /api/notifications — the traveler-facing message log, newest first. */
notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.query.tripId) || store.activeTrip();
    const all = store.listNotifications(trip?.id).sort((a, b) => new Date(b.at) - new Date(a.at));
    const level = req.query.level;
    const items = level ? all.filter((entry) => entry.level === level) : all;
    return ok(res, items, {
      count: items.length,
      unread: all.filter((entry) => !entry.read).length,
      levels: {
        success: all.filter((entry) => entry.level === 'success').length,
        warning: all.filter((entry) => entry.level === 'warning').length,
        info: all.filter((entry) => entry.level === 'info').length,
        critical: all.filter((entry) => entry.level === 'critical').length,
      },
    });
  }),
);

/** POST /api/notifications/read — mark one, several or all messages as read. */
notificationsRouter.post(
  '/read',
  asyncHandler(async (req, res) => {
    const { ids } = validate(req.body, { ids: { type: 'array' } }, 'read request');
    const unread = store.markNotificationsRead(ids);
    const updated = ids.length
      ? ids.map((id) => store.snapshot().notifications.find((entry) => entry.id === id)).filter(Boolean)
      : store.listNotifications();
    updated.forEach((entry) => broadcastNotification(entry));
    return ok(res, updated, { marked: updated.length, unreadRemaining: unread, all: !ids.length });
  }),
);

/**
 * POST /api/notifications/test
 * Fires a real notification through every enabled channel — used by the
 * notification center to prove the delivery pipeline works during a demo.
 */
notificationsRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const payload = validate(
      req.body,
      {
        level: { type: 'string', enum: ['info', 'success', 'warning', 'critical'], default: 'info' },
        title: { type: 'string', default: 'Test alert from TravelGuard' },
        body: { type: 'string', default: 'Delivery pipeline check — push, SMS and email are wired to the active preferences.' },
      },
      'notification',
    );

    const trip = store.activeTrip();
    const notification = await notify({
      trip,
      level: payload.level,
      category: 'SYSTEM',
      title: payload.title,
      body: payload.body,
      action: { label: 'Open notification center', href: '/notifications' },
      // Omit channels so the traveler's enabled channels are used, including quiet-hour rules.
    });
    broadcastNotification(notification);

    return ok(res, notification, { channels: notification.channels, quietHoursSuppressed: notification.quietHoursSuppressed || false });
  }),
);

/** GET /api/notifications/:notificationId */
notificationsRouter.get(
  '/:notificationId',
  asyncHandler(async (req, res) => {
    const found = store.snapshot().notifications.find((entry) => entry.id === req.params.notificationId);
    if (!found) throw notFound(`No notification ${req.params.notificationId}`);
    return ok(res, found, { sentAt: found.at, serverTime: clock.now().toISOString() });
  }),
);
