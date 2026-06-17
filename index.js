require('dotenv').config({ quiet: true });

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const webhookRouter = require('./routes/webhook');
const { handleSyncRuleChange } = require('./services/lifecycleService');
const { runBackfill } = require('./services/backfillService');
const { runCleanup } = require('./services/cleanupService');
const { renewExpiringWebhooks } = require('./services/webhookRenewalService');
const { logger, redact } = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/', webhookRouter);

app.listen(PORT, () => {
  logger.info(`CalSync server running on port ${PORT}`);
});

// --- Sync rule change polling ---

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const syncRuleState = new Map(); // rule id → { is_active, updated_at, row }
let isFirstRun = true;
let isPolling = false;

async function checkSyncRuleChanges() {
  if (isPolling) {
    logger.info('[poller] Previous poll still running — skipping');
    return;
  }

  isPolling = true;

  try {
    const { data: rules, error } = await supabase.from('sync_rules').select('*');

    if (error) {
      logger.error('[poller] Failed to fetch sync rules:', error.message);
      return;
    }

    // First run — populate map without triggering any lifecycle actions
    if (isFirstRun) {
      rules.forEach((r) => {
        syncRuleState.set(r.id, { is_active: r.is_active, updated_at: r.updated_at, row: r });
      });
      logger.info(`[poller] Initial state loaded — tracking ${rules.length} sync rule(s)`);
      isFirstRun = false;
      return;
    }

    const currentIds = new Set(rules.map((r) => r.id));

    // Detect deleted rules — run cleanup before removing from map
    for (const [id, state] of syncRuleState) {
      if (!currentIds.has(id)) {
        logger.info(`[poller] Sync rule deleted: "${state.row.label}" (${redact(id, 'rule')}) — triggering cleanup`);
        await runCleanup(id, state.row.target_calendar_id);
        syncRuleState.delete(id);
      }
    }

    // Detect changes and new rules
    for (const rule of rules) {
      const prev = syncRuleState.get(rule.id);

      if (!prev) {
        // New rule detected — track it, and run backfill if already active
        logger.info(`[poller] New sync rule detected: "${rule.label}" (is_active: ${rule.is_active})`);
        syncRuleState.set(rule.id, { is_active: rule.is_active, updated_at: rule.updated_at, row: rule });
        if (rule.is_active) {
          logger.info('[poller] New rule is already active — running backfill');
          await runBackfill(rule.id);
        }
        continue;
      }

      if (rule.is_active !== prev.is_active) {
        logger.info(`[poller] is_active changed for "${rule.label}": ${prev.is_active} -> ${rule.is_active}`);
        await handleSyncRuleChange(prev.row, rule);
      }

      syncRuleState.set(rule.id, { is_active: rule.is_active, updated_at: rule.updated_at, row: rule });
    }

  } finally {
    isPolling = false;
  }
}

setInterval(checkSyncRuleChanges, 10000);

// --- Webhook renewal cron job ---

let isRenewing = false;

async function runRenewal() {
  if (isRenewing) {
    logger.info('[webhookRenewal] Renewal already running — skipping');
    return;
  }
  isRenewing = true;
  try {
    await renewExpiringWebhooks();
  } finally {
    isRenewing = false;
  }
}

logger.info('[webhookRenewal] Renewal job initialised — runs every 24h, first run in 5 seconds');
setTimeout(runRenewal, 5 * 1000);
setInterval(runRenewal, 86400000);
