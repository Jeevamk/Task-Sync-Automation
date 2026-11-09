import * as Joi from 'joi';

/**
 * Environment variables checked at startup.
 * Step 1 needs only the app, database, Redis and n8n values.
 * Trello, Slack and the other secrets become required in the steps that use them.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  PUBLIC_BASE_URL: Joi.string().uri().default('http://localhost:3000'),

  DIRECT_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),

  N8N_BASE_URL: Joi.string().uri().required(),
  N8N_EVENT_WEBHOOK_URL: Joi.string().uri().allow('').optional(),
  N8N_EVENT_SIGNING_SECRET: Joi.string().allow('').optional(),
  INTERNAL_API_KEY: Joi.string().allow('').optional(),

  TRELLO_API_KEY: Joi.string().allow('').optional(),
  TRELLO_TOKEN: Joi.string().allow('').optional(),
  TRELLO_APP_SECRET: Joi.string().allow('').optional(),

  SLACK_BOT_TOKEN: Joi.string().allow('').optional(),
  SLACK_SIGNING_SECRET: Joi.string().allow('').optional(),

  SHEET_SYNC_SECRET: Joi.string().allow('').optional(),
  JWT_SECRET: Joi.string().allow('').optional(),
  GOOGLE_OAUTH_CLIENT_ID: Joi.string().allow('').optional(),
});
