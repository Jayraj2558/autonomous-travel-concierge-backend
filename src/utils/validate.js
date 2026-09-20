import { badRequest } from './http.js';

/**
 * Tiny schema validator — enough to keep the API defensive without pulling in a
 * dependency. Each field may declare `type`, `required`, `enum`, `min`, `max`.
 */
export function validate(body, schema, label = 'payload') {
  const errors = [];
  const clean = {};

  Object.entries(schema).forEach(([field, rule]) => {
    const value = body?.[field];
    const provided = value !== undefined && value !== null && value !== '';

    if (!provided) {
      if (rule.required) errors.push({ field, message: 'is required' });
      else if (rule.default !== undefined) clean[field] = rule.default;
      return;
    }

    if (rule.type === 'string' && typeof value !== 'string') {
      errors.push({ field, message: 'must be a string' });
      return;
    }
    if (rule.type === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        errors.push({ field, message: 'must be a number' });
        return;
      }
      if (rule.min !== undefined && num < rule.min) errors.push({ field, message: `must be ≥ ${rule.min}` });
      if (rule.max !== undefined && num > rule.max) errors.push({ field, message: `must be ≤ ${rule.max}` });
      clean[field] = num;
      return;
    }
    if (rule.type === 'boolean') {
      clean[field] = value === true || value === 'true';
      return;
    }
    if (rule.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push({ field, message: 'must be an array' });
        return;
      }
      clean[field] = value;
      return;
    }
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push({ field, message: `must be one of ${rule.enum.join(', ')}` });
      return;
    }
    clean[field] = typeof value === 'string' ? value.trim() : value;
  });

  if (errors.length) {
    throw badRequest(`Invalid ${label}`, errors);
  }
  return clean;
}
