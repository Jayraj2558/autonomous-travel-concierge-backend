import { store } from '../domain/store.js';
import { sendNotification } from '../mocks/notificationProvider.js';
import { broadcastNotification } from './realtime.js';
import { isWithinQuietHours } from '../utils/window.js';

/**
 * Notification service. Persists the notification, pushes it to connected
 * browsers over the realtime channel, then fans it out to the (mock) delivery
 * gateway and reports per-channel receipts.
 */
export async function notify({ trip, level = 'info', category = 'MONITORING', title, body, action, channels, priority = 'normal' }) {
  const preferences = store.getPreferences(trip?.travelerId);
  const requested = channels || channelsFor(preferences, level, priority);
  const quiet = isWithinQuietHours(preferences.notifications?.quietHours);

  const notification = store.addNotification({
    tripId: trip?.id,
    at: new Date().toISOString(),
    level,
    category,
    title,
    body,
    channels: requested,
    priority,
    quietHoursSuppressed: quiet && priority !== 'urgent',
    action: action || null,
    read: false,
  });

  broadcastNotification(notification);

  let receipts = [];
  try {
    const result = await sendNotification({ notification, channels: requested.filter((c) => c !== 'in_app') });
    receipts = result.data.receipts;
  } catch (error) {
    receipts = requested.map((channel) => ({ channel, status: 'FAILED', error: error.message }));
  }

  notification.receipts = receipts;
  return notification;
}

function channelsFor(preferences, level, priority) {
  const prefs = preferences.notifications || {};
  const enabled = ['push', 'sms', 'email', 'whatsapp'].filter((channel) => prefs[channel]);
  if (priority === 'urgent') return ['in_app', ...enabled];
  if (level === 'info') return ['in_app', ...enabled.filter((c) => c !== 'sms')];
  return ['in_app', ...enabled];
}
