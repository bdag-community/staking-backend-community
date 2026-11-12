import { Op, QueryTypes } from "sequelize";
import {
  UnresolvedTransaction,
  VisibilityActionAttempt,
  VisibilityActionEvent,
} from "../models/index.model";
import sequelize from "../models/db.model";
import {
  VisibilityAction,
  VisibilityActionAttemptAttributes,
  VisibilityActionEventAttributes,
  VisibilityAttemptStatus,
  VisibilityDateRange,
} from "../interfaces/visibility.interface";

type AttemptFilters = VisibilityDateRange & {
  action?: VisibilityAction;
  statuses?: VisibilityAttemptStatus[];
  stakerAddress?: string;
  txHash?: string;
  limit?: number;
};

type RawCount = { count: string | number };

const STATUS_RANK: Record<VisibilityAttemptStatus, number> = {
  started: 1,
  submitted: 2,
  pending: 3,
  stuck: 4,
  failed: 5,
  reverted: 6,
  confirmed: 7,
  replaced: 7,
};

class VisibilityRepository {
  private getTableName(model: { getTableName: () => any }): string {
    const tableName = model.getTableName();
    if (typeof tableName === "string") return tableName;
    if (tableName.schema) {
      return `"${tableName.schema}"."${tableName.tableName}"`;
    }
    return `"${tableName.tableName}"`;
  }

  private buildRangeWhere(range: VisibilityDateRange) {
    if (!range.from && !range.to) return {};

    return {
      lastStageAt: {
        ...(range.from ? { [Op.gte]: range.from } : {}),
        ...(range.to ? { [Op.lt]: range.to } : {}),
      },
    };
  }

  private buildSqlRange(column: string, range: VisibilityDateRange) {
    const clauses: string[] = [];
    if (range.from) clauses.push(`"${column}" >= :from`);
    if (range.to) clauses.push(`"${column}" < :to`);
    return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  }

  private normalizeCount(value: string | number | undefined): number {
    if (typeof value === "number") return value;
    return Number(value ?? 0);
  }

  public async appendEvent(
    event: VisibilityActionEventAttributes,
  ): Promise<VisibilityActionEvent> {
    return await VisibilityActionEvent.create(event);
  }

  public async findAttemptByTxHash(
    txHash: string,
  ): Promise<VisibilityActionAttempt | null> {
    return await VisibilityActionAttempt.findOne({
      where: { txHash: txHash.toLowerCase() },
    });
  }

  public async upsertAttempt(
    data: VisibilityActionAttemptAttributes,
  ): Promise<VisibilityActionAttempt> {
    const existing = await VisibilityActionAttempt.findOne({
      where: { attemptId: data.attemptId },
    });

    if (!existing) {
      return await VisibilityActionAttempt.create(data);
    }

    const shouldPromoteStatus =
      STATUS_RANK[data.status] >= STATUS_RANK[existing.status];

    existing.action = data.action;
    if (shouldPromoteStatus) {
      existing.status = data.status;
      existing.success = data.success;
    }
    existing.lastStageAt = data.lastStageAt;
    existing.durationMs = data.durationMs ?? existing.durationMs ?? null;
    existing.stakerAddress =
      data.stakerAddress ?? existing.stakerAddress ?? null;
    existing.poolAddress = data.poolAddress ?? existing.poolAddress ?? null;
    existing.txHash = data.txHash ?? existing.txHash ?? null;
    existing.amountRaw = data.amountRaw ?? existing.amountRaw ?? null;
    existing.amountFormatted =
      data.amountFormatted ?? existing.amountFormatted ?? null;
    existing.metadata = data.metadata ?? existing.metadata ?? null;

    if (shouldPromoteStatus && data.finalErrorCode !== undefined) {
      existing.finalErrorCode = data.finalErrorCode;
    }
    if (shouldPromoteStatus && data.finalErrorMessage !== undefined) {
      existing.finalErrorMessage = data.finalErrorMessage;
    }

    await existing.save();
    return existing;
  }

  public async getActionSummary(range: VisibilityDateRange) {
    const table = this.getTableName(VisibilityActionAttempt);
    const where = this.buildSqlRange("lastStageAt", range);

    const rows: any[] = await sequelize.query(
      `
      SELECT
        "action",
        COUNT(*)::INTEGER AS "attempts",
        COUNT(*) FILTER (WHERE "txHash" IS NOT NULL)::INTEGER AS "submitted",
        COUNT(*) FILTER (WHERE "status" = 'confirmed')::INTEGER AS "confirmed",
        COUNT(*) FILTER (WHERE "status" = 'failed')::INTEGER AS "failed",
        COUNT(*) FILTER (WHERE "status" = 'reverted')::INTEGER AS "reverted",
        COUNT(*) FILTER (WHERE "status" = 'stuck')::INTEGER AS "stuck",
        COUNT(*) FILTER (WHERE "status" = 'replaced')::INTEGER AS "replaced"
      FROM ${table}
      ${where}
      GROUP BY "action"
      ORDER BY "action" ASC
      `,
      {
        replacements: { from: range.from, to: range.to },
        type: QueryTypes.SELECT,
      },
    );

    return rows.map((row) => {
      const attempts = this.normalizeCount(row.attempts);
      const confirmed = this.normalizeCount(row.confirmed);
      const replaced = this.normalizeCount(row.replaced);
      const successes = confirmed + replaced;

      return {
        action: row.action as VisibilityAction,
        attempts,
        submitted: this.normalizeCount(row.submitted),
        confirmed,
        failed: this.normalizeCount(row.failed),
        reverted: this.normalizeCount(row.reverted),
        stuck: this.normalizeCount(row.stuck),
        replaced,
        successRate:
          attempts > 0 ? Number(((successes / attempts) * 100).toFixed(1)) : 0,
      };
    });
  }

  public async getTotals(range: VisibilityDateRange) {
    const where = this.buildRangeWhere(range);
    const [attempts, confirmed, failed, reverted, stuck] = await Promise.all([
      VisibilityActionAttempt.count({ where }),
      VisibilityActionAttempt.count({
        where: { ...where, status: { [Op.in]: ["confirmed", "replaced"] } },
      }),
      VisibilityActionAttempt.count({ where: { ...where, status: "failed" } }),
      VisibilityActionAttempt.count({
        where: { ...where, status: "reverted" },
      }),
      VisibilityActionAttempt.count({ where: { ...where, status: "stuck" } }),
    ]);

    return {
      attempts,
      confirmed,
      failed,
      reverted,
      stuck,
      successRate:
        attempts > 0 ? Number(((confirmed / attempts) * 100).toFixed(1)) : 0,
    };
  }

  public async getTopErrors(range: VisibilityDateRange, limit = 10) {
    const table = this.getTableName(VisibilityActionAttempt);
    const rangeWhere = this.buildSqlRange("lastStageAt", range);
    const where = rangeWhere
      ? `${rangeWhere} AND ("finalErrorMessage" IS NOT NULL OR "status" IN ('failed', 'reverted', 'stuck'))`
      : `WHERE "finalErrorMessage" IS NOT NULL OR "status" IN ('failed', 'reverted', 'stuck')`;

    const rows: any[] = await sequelize.query(
      `
      SELECT
        "action",
        COALESCE(NULLIF("finalErrorCode", ''), UPPER("status")) AS "errorCode",
        COALESCE(NULLIF("finalErrorMessage", ''), "status") AS "errorMessage",
        COUNT(*)::INTEGER AS "count",
        MAX("lastStageAt") AS "lastSeenAt"
      FROM ${table}
      ${where}
      GROUP BY "action", "errorCode", "errorMessage"
      ORDER BY "count" DESC, "lastSeenAt" DESC
      LIMIT :limit
      `,
      {
        replacements: { ...range, limit },
        type: QueryTypes.SELECT,
      },
    );

    return rows.map((row) => ({
      action: row.action as VisibilityAction,
      errorCode: row.errorCode as string,
      errorMessage: row.errorMessage as string,
      count: this.normalizeCount(row.count),
      lastSeenAt: row.lastSeenAt,
    }));
  }

  public async findAttempts(filters: AttemptFilters) {
    const where: any = this.buildRangeWhere(filters);

    if (filters.action) where.action = filters.action;
    if (filters.statuses?.length) where.status = { [Op.in]: filters.statuses };
    if (filters.stakerAddress) {
      where.stakerAddress = filters.stakerAddress.toLowerCase();
    }
    if (filters.txHash) where.txHash = filters.txHash.toLowerCase();

    return await VisibilityActionAttempt.findAll({
      where,
      order: [
        ["lastStageAt", "DESC"],
        ["createdAt", "DESC"],
      ],
      limit: filters.limit ?? 25,
    });
  }

  public async getUnresolvedStatusCounts() {
    const rows = (await UnresolvedTransaction.findAll({
      attributes: [
        "status",
        [sequelize.fn("COUNT", sequelize.col("status")), "count"],
      ],
      group: ["status"],
      raw: true,
    })) as unknown as Array<{ status: string; count: string | number }>;

    return rows.reduce(
      (result, row) => {
        result[row.status] = this.normalizeCount(row.count);
        return result;
      },
      {} as Record<string, number>,
    );
  }

  public async getLastEventAt(): Promise<Date | null> {
    const row = (await VisibilityActionEvent.findOne({
      attributes: [[sequelize.fn("MAX", sequelize.col("createdAt")), "count"]],
      raw: true,
    })) as unknown as RawCount | null;

    return row?.count ? new Date(row.count as string) : null;
  }
}

export default new VisibilityRepository();
