import { Router } from "express";
import {
  listServices,
  listServicesByProvider,
  getService,
  getServiceCount,
  deactivateServiceOnChain,
  updateReputation,
  isAllowedReputationAgent,
  buildUnsignedRegistryTx,
  validatePreparedRegistrySubmission,
  submitSignedRegistryTx,
  SERVICE_MAX_TTL,
  SERVICE_TTL_WARNING_LEDGERS,
} from "../lib/contract.js";
import { getCurrentLedgerSequence } from "../lib/stellar.js";
import { getReputationHistory } from "../lib/reputationHistory.js";
import logger, { requestContext } from "../lib/logger.js";
import { ContractError } from "../lib/ContractError.js";
import { writeRateLimiter } from "../middleware/rateLimiter.js";
import { isValidStellarAddress } from "../middleware/addressValidator.js";

const router = Router();

const PAGE_SIZE = 20;
const SERVICE_CATEGORIES = new Set(["search", "weather", "finance", "ai", "data", "compute"]);
const PRICE_USDC_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function normalizePriceUsdc(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const normalized = String(value);
    if (!PRICE_USDC_REGEX.test(normalized)) return null;
    return value >= 0.0001 ? normalized : null;
  }

  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value || !PRICE_USDC_REGEX.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0.0001) {
    return null;
  }

  return normalized;
}

function parsePositiveSafeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Appends ttl_warning:true when the entry's estimated remaining TTL falls
// below SERVICE_TTL_WARNING_LEDGERS. Omits the field entirely when currentLedger
// is unavailable so callers can always treat absence as "no warning data".
function parseFiniteNumericValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function annotateTtlWarning(service, currentLedger) {
  const parsedCurrentLedger = parseFiniteNumericValue(currentLedger);
  const registeredAt = parseFiniteNumericValue(service?.registered_at);

  if (parsedCurrentLedger === null || registeredAt === null) {
    return { ...service };
  }

  const expiryLedger = registeredAt + SERVICE_MAX_TTL;
  const warningOnset = expiryLedger - SERVICE_TTL_WARNING_LEDGERS;

  return {
    ...service,
    ttl_warning: parsedCurrentLedger >= warningOnset,
  };
}

// Returns a request-scoped child logger that always carries the request id.
// Falls back to the root logger when the AsyncLocalStorage context is missing.
function requestLogger(req) {
  const requestId = requestContext.getStore()?.requestId ?? req?.id;
  return requestId ? logger.child({ requestId }) : logger;
}

router.get("/services", async (req, res) => {
  try {
    const { category, q, offset: offsetStr, limit: limitStr } = req.query;
    const offset = Math.max(0, parseInt(offsetStr, 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(limitStr, 10) || PAGE_SIZE));

    const [servicesResult, ledgerResult] = await Promise.allSettled([
      listServices({ category: category || undefined, offset, limit }),
      getCurrentLedgerSequence(),
    ]);

    if (servicesResult.status === "rejected") throw servicesResult.reason;

    if (ledgerResult.status === "rejected") {
      logger.warn(
        { err: ledgerResult.reason },
        "Failed to fetch current ledger for TT \ annotation on GET /api/services",
      );
    }

    const currentLedger =
      ledgerResult.status === "fulfilled" ? ledgerResult.value : null;

    let services = servicesResult.value.map((s) =>
      annotateTtlWarning(s, currentLedger),
    );

    if (q && typeof q === "string" && q.trim()) {
      const query = q.trim().toLowerCase();
      services = services.filter(
        (s) =>
          (s.name && s.name.toLowerCase().includes(query)) ||
          (s.description && s.description.toLowerCase().includes(query)),
      );
    }

    res.json({ services, count: services.length });
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "SIMULATION_FAILED") {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
    }
    logger.error({ err }, "GET /api/services failed");
    res.status(500).json({ error: "Failed to fetch services", code: "FETCH_ERROR" });
  }
});

router.get("/services/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }

    const [serviceResult, ledgerResult] = await Promise.allSettled([
      getService(id),
      getCurrentLedgerSequence(),
    ]);

    if (serviceResult.status === "rejected") throw serviceResult.reason;

    const service = serviceResult.value;
    if (!service) {
      return res
        .status(404)
        .json({ error: "Service not found", code: "NOT_FOUND" });
    }

    if (ledgerResult.status === "rejected") {
      logger.warn(
        { err: ledgerResult.reason },
        "Failed to fetch current ledger for TTL annotation on GET /api/services/:id",
      );
    }

    const currentLedger =
      ledgerResult.status === "fulfilled" ? ledgerResult.value : null;
    res.json(annotateTtlWarning(service, currentLedger));
  } catch (err) {
    logger.error({ err }, "GET /api/services/:id failed");
    res.status(500).json({ error: "Failed to fetch service", code: "FETCH_ERROR" });
  }
});

/**
 * POST /api/services/:id/deactivate
 * Provider-authenticated deactivation. The caller must supply a valid
 * `providerAddress` that matches the service's registered provider.
 * The on-chain contract enforces `provider.require_auth()` so the returned
 * unsigned transaction must be signed by the provider's wallet (e.g.
 * Freighter) and submitted through POST /api/registry/submit-signed-tx.
 *
 * Body: { providerAddress: string }
 * Returns: { xdr, submitToken } — unsigned tx ready for wallet signing
 */
router.post("/services/:id/deactivate", writeRateLimiter(), async (req, res) => {
  const parsedId = parsePositiveSafeInteger(req.params.id);
  if (parsedId == null) {
    return res
      .status(400)
      .json({ error: "Invalid service ID", code: "INVALID_ID" });
  }

  try {
    const { providerAddress } = req.body ?? {};
    if (!isValidStellarAddress(providerAddress)) {
      return res.status(400).json({
        error: "`providerAddress` must be a valid Stellar address",
        code: "INVALID_BODY",
      });
    }

    const prepared = await deactivateServiceOnChain(parsedId, providerAddress);
    logger.info({ id: parsedId, providerAddress }, "Built unsigned deactivation tx");
    res.json(prepared);
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "SERVICE_NOT_FOUND") {
        return res.status(404).json({ error: err.message, code: err.code });
      }
      if (err.code === "SERVICE_READ_FAILED") {
        return res.status(502).json({ error: err.message, code: err.code });
      }
      if (err.code === "PROVIDER_MISMATCH") {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      if (err.code === "ALREADY_INACTIVE") {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error({ err, id: parsedId }, "POST /api/services/:id/deactivate failed");
    res.status(500).json({
      error: "Failed to deactivate service",
      code: "DEACTIVATE_ERROR",
    });
  }
});

router.get("/services/:id/history", async (req, res) => {
  let id;
  try {
    id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }
    const service = await getService(id);
    if (!service) {
      return res
        .status(404)
        .json({ error: "Service not found", code: "NOT_FOUND" });
    }
    const history = getReputationHistory(id);
    res.json({ history });
  } catch (err) {
    logger.error({ err, id }, "GET /api/services/:id/history failed");
    res.status(500).json({ error: "Failed to fetch reputation history", code: "FETCH_ERROR" });
  }
});

router.get("/stats", async (req, res) => {
  const log = requestLogger(req);
  const startedAt = process.hrtime.bigint();
  const contractStartedAt = process.hrtime.bigint();
  const context = {
    route: "GET /stats",
    callerAddress: req.ip,
  };

  try {
    const totalServices = await getServiceCount();
    const totalPages = Math.ceil(totalServices / PAGE_SIZE);
    let allServices = [];
    for (let i = 0; i < totalPages; i++) {
      const page = await listServices({ offset: i * PAGE_SIZE, limit: PAGE_SIZE });
      allServices.push(...page);
    }

    const categories = [...new Set(allServices.map((s) => s.category))];
    const latestService = allServices.reduce(
      (latest, s) =>
        s.registered_at > (latest?.registered_at ?? 0) ? s : latest,
      null,
    );

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const contractDurationMs = Number(process.hrtime.bigint() - contractStartedAt) / 1e6;

    log.info(
      {
        ...context,
        outcome: "success",
        statusCode: res.statusCode,
        durationMs,
        contractDurationMs,
        totalServices,
        categoryCount: categories.length,
        latestServiceId: latestService?.id ?? null,
      },
      "GET /api/stats completed",
    );

    res.json({ totalServices, categories, latestService });
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const contractDurationMs = Number(process.hrtime.bigint() - contractStartedAt) / 1e6;

    log.error(
      {
        ...context,
        err,
        outcome: "error",
        statusCode: 500,
        durationMs,
        contractDurationMs,
        errorCode: err instanceof ContractError ? err.code : undefined,
      },
      "GET /api/stats failed",
    );
    res.status(500).json({ error: "Failed to fetch stats", code: "FETCH_ERROR" });
  }
});

router.get("/registry/by-provider/:address", async (req, res) => {
  try {
    const { address } = req.params;
    if (!isValidStellarAddress(address)) {
      return res.status(400).json({
        error: "Invalid Stellar address format",
        code: "INVALID_ADDRESS",
      });
    }

    const [servicesResult, ledgerResult] = await Promise.allSettled([
      listServicesByProvider(address),
      getCurrentLedgerSequence(),
    ]);

    if (servicesResult.status === "rejected") throw servicesResult.reason;

    if (ledgerResult.status === "rejected") {
      logger.warn(
        { err: ledgerResult.reason },
        "Failed to fetch current ledger for TTL annotation on GET /api/registry/by-provider/:address",
      );
    }

    const currentLedger =
      ledgerResult.status === "fulfilled" ? ledgerResult.value : null;

    const services = servicesResult.value.map((s) =>
      annotateTtlWarning(s, currentLedger),
    );

    res.json({ services, count: services.length });
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "SIMULATION_FAILED") {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
    }
    logger.error({ err }, "GET /api/registry/by-provider/:address failed");
    res.status(500).json({ error: "Failed to fetch services", code: "FETCH_ERROR" });
  }
});

export default router;
