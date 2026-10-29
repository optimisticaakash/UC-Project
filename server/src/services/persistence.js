const mongoose = require("mongoose");
const crypto = require("node:crypto");

const candidateSchema = new mongoose.Schema(
  {
    candidateId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    loginIdentifier: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["candidate"], default: "candidate", immutable: true },
    active: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);

const adminSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    loginIdentifier: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["admin"], default: "admin", immutable: true },
    active: { type: Boolean, default: true },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);

const authSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    role: { type: String, enum: ["admin", "candidate"], required: true },
    principalId: { type: String, required: true },
    name: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const adminBootstrapSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    claimedAt: { type: Date, required: true, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: "uc_admin_bootstrap" },
);

const interviewSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    candidateId: { type: String, index: true },
    status: { type: String, required: true, index: true },
    startedAt: { type: String, required: true },
    updatedAt: { type: Date, required: true },
    state: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { versionKey: false },
);
interviewSessionSchema.index({ status: 1, startedAt: -1 });

const InterviewSession =
  mongoose.models.UcInterviewSession ||
  mongoose.model("UcInterviewSession", interviewSessionSchema);
const Candidate =
  mongoose.models.UcCandidate || mongoose.model("UcCandidate", candidateSchema);
const Admin = mongoose.models.UcAdmin || mongoose.model("UcAdmin", adminSchema);
const AuthSession = mongoose.models.UcAuthSession || mongoose.model("UcAuthSession", authSessionSchema);
const AdminBootstrap = mongoose.models.UcAdminBootstrap || mongoose.model("UcAdminBootstrap", adminBootstrapSchema);

function createPersistence({
  sessionModel = InterviewSession,
  candidateModel = Candidate,
  adminModel = Admin,
  authSessionModel = AuthSession,
  adminBootstrapModel = AdminBootstrap,
  connectImpl = (uri, options) => mongoose.connect(uri, options),
  connection = mongoose.connection,
  gridFsBucketFactory = (db) => new mongoose.mongo.GridFSBucket(db, { bucketName: "uc_interview_reports" }),
} = {}) {
  const reportPdfWrites = new Map();

  async function backfillCandidateIds() {
    if (typeof candidateModel.find !== "function" || typeof candidateModel.updateOne !== "function") return;
    const missing = await candidateModel.find({
      $or: [
        { candidateId: { $exists: false } },
        { candidateId: null },
        { candidateId: "" },
      ],
    }, { _id: 1 }).lean();
    for (const candidate of missing) {
      let assigned = false;
      for (let attempt = 0; attempt < 5 && !assigned; attempt += 1) {
        try {
          const result = await candidateModel.updateOne(
            {
              _id: candidate._id,
              $or: [
                { candidateId: { $exists: false } },
                { candidateId: null },
                { candidateId: "" },
              ],
            },
            { $set: { candidateId: crypto.randomUUID() } },
          );
          assigned = result.matchedCount === 0 || result.modifiedCount === 1;
        } catch (error) {
          if (error?.code !== 11000 || attempt === 4) throw error;
        }
      }
      if (!assigned) throw new Error("Could not safely assign an ID to an existing candidate account.");
    }
  }

  async function readGridFsFile(bucket, fileId) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = bucket.openDownloadStream(new mongoose.Types.ObjectId(fileId));
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  return {
    isConnected() {
      return connection.readyState === 1;
    },

    async connect(uri) {
      if (!uri) {
        const error = new Error("MongoDB URI is required for persistent interview storage.");
        error.code = "MONGODB_URI_REQUIRED";
        throw error;
      }
      await connectImpl(uri, { serverSelectionTimeoutMS: 10000 });
      await Promise.all([
        sessionModel.init(), adminModel.init(),
        authSessionModel.init(), adminBootstrapModel.init(),
      ]);
      await backfillCandidateIds();
      await candidateModel.init();
      return true;
    },

    async loadSessions() {
      if (!this.isConnected()) throw new Error("MongoDB interview storage is not connected.");
      const records = await sessionModel.find({}, { _id: 0, state: 1 }).lean();
      return records.map((record) => record.state).filter((state) => state?.sessionId);
    },

    async saveSession(session) {
      if (!this.isConnected()) throw new Error("MongoDB interview storage is not connected.");
      if (!session?.sessionId || !session?.status || !session?.startedAt) {
        throw new TypeError("A complete interview session is required for persistence.");
      }
      await sessionModel.replaceOne(
        { sessionId: session.sessionId },
        {
          sessionId: session.sessionId,
          candidateId: session.candidateId,
          status: session.status,
          startedAt: session.startedAt,
          updatedAt: new Date(),
          state: session,
        },
        { upsert: true, runValidators: true },
      );
    },

    async createCandidate(candidate) {
      if (!this.isConnected()) throw new Error("MongoDB candidate storage is not connected.");
      return candidateModel.create(candidate);
    },

    async findCandidateByLogin(loginIdentifier) {
      if (!this.isConnected()) throw new Error("MongoDB candidate storage is not connected.");
      return candidateModel
        .findOne({ loginIdentifier })
        .select("+passwordHash")
        .lean();
    },

    async listCandidates() {
      if (!this.isConnected()) throw new Error("MongoDB candidate storage is not connected.");
      return candidateModel
        .find({}, { passwordHash: 0, _id: 0 })
        .sort({ createdAt: -1 })
        .lean();
    },

    async findCandidateById(candidateId) {
      if (!this.isConnected()) throw new Error("MongoDB candidate storage is not connected.");
      return candidateModel.findOne({ candidateId }, { passwordHash: 0, _id: 0 }).lean();
    },

    async countCandidates() {
      if (!this.isConnected()) throw new Error("MongoDB candidate storage is not connected.");
      return candidateModel.countDocuments({});
    },

    async createAdmin(admin) {
      if (!this.isConnected()) throw new Error("MongoDB admin storage is not connected.");
      return adminModel.create(admin);
    },

    async findAdminByLogin(loginIdentifier) {
      if (!this.isConnected()) throw new Error("MongoDB admin storage is not connected.");
      return adminModel.findOne({ loginIdentifier }).select("+passwordHash").lean();
    },

    async countAdmins() {
      if (!this.isConnected()) throw new Error("MongoDB admin storage is not connected.");
      return adminModel.countDocuments({});
    },

    async listAdmins() {
      if (!this.isConnected()) throw new Error("MongoDB admin storage is not connected.");
      return adminModel.find({}, { _id: 0, passwordHash: 0 }).sort({ createdAt: 1 }).lean();
    },

    async deleteAdminAndSessions(adminId) {
      if (!this.isConnected() || typeof connection.startSession !== "function") {
        const error = new Error("Admin deletion requires MongoDB transaction support.");
        error.code = "TRANSACTIONS_UNAVAILABLE";
        throw error;
      }
      const dbSession = await connection.startSession();
      let outcome = null;
      try {
        await dbSession.withTransaction(async () => {
          // A shared write serializes concurrent deletions so two admins cannot
          // both observe the same last-two-admin count and remove each other.
          await adminBootstrapModel.updateOne(
            { _id: "admin-deletion-guard" },
            { $set: { claimedAt: new Date() } },
            { upsert: true, session: dbSession },
          );
          const target = await adminModel.findOne({ adminId }).session(dbSession).lean();
          if (!target?.active) { outcome = "missing"; return; }
          if (await adminModel.countDocuments({ active: true }).session(dbSession) <= 1) {
            outcome = "last-admin";
            return;
          }
          await adminModel.deleteOne({ adminId, active: true }, { session: dbSession });
          await authSessionModel.deleteMany({ role: "admin", principalId: adminId }, { session: dbSession });
          outcome = "deleted";
        });
        return outcome;
      } finally {
        await dbSession.endSession();
      }
    },

    async deactivateCandidateAndSessions(candidateId) {
      if (!this.isConnected() || typeof connection.startSession !== "function") {
        const error = new Error("Candidate deactivation requires MongoDB transaction support.");
        error.code = "TRANSACTIONS_UNAVAILABLE";
        throw error;
      }
      const dbSession = await connection.startSession();
      let candidate = null;
      try {
        await dbSession.withTransaction(async () => {
          candidate = await candidateModel.findOneAndUpdate(
            { candidateId, active: true },
            { $set: { active: false } },
            { new: true, session: dbSession, projection: { _id: 0, passwordHash: 0 } },
          ).lean();
          if (!candidate) return;
          await authSessionModel.deleteMany({ role: "candidate", principalId: candidateId }, { session: dbSession });
        });
        return candidate;
      } finally {
        await dbSession.endSession();
      }
    },

    async activateCandidate(candidateId) {
      if (!this.isConnected()) throw new Error("MongoDB candidate storage is not connected.");
      return candidateModel.findOneAndUpdate(
        { candidateId, active: false, deletedAt: null },
        { $set: { active: true }, $unset: { deletedAt: 1 } },
        { new: true, projection: { _id: 0, passwordHash: 0 } },
      ).lean();
    },

    async deleteCandidateAccountAndSessions(candidateId) {
      if (!this.isConnected() || typeof connection.startSession !== "function") {
        const error = new Error("Candidate account removal requires MongoDB transaction support.");
        error.code = "TRANSACTIONS_UNAVAILABLE";
        throw error;
      }
      const dbSession = await connection.startSession();
      let candidate = null;
      try {
        await dbSession.withTransaction(async () => {
          candidate = await candidateModel.findOneAndUpdate(
            { candidateId, deletedAt: null },
            { $set: { active: false, deletedAt: new Date() } },
            { new: true, session: dbSession, projection: { _id: 0, passwordHash: 0 } },
          ).lean();
          if (!candidate) return;
          await authSessionModel.deleteMany({ role: "candidate", principalId: candidateId }, { session: dbSession });
        });
        return candidate;
      } finally {
        await dbSession.endSession();
      }
    },

    async claimFirstAdminSetup() {
      if (!this.isConnected()) throw new Error("MongoDB admin storage is not connected.");
      try {
        const claim = await adminBootstrapModel.findOneAndUpdate(
          {
            _id: "first-admin",
            $or: [
              { claimedAt: { $exists: false } },
              { claimedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
            ],
          },
          { $set: { claimedAt: new Date() } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return Boolean(claim);
      } catch (error) {
        if (error?.code === 11000) return false;
        throw error;
      }
    },

    async releaseFirstAdminSetup() {
      if (!this.isConnected()) throw new Error("MongoDB admin storage is not connected.");
      await adminBootstrapModel.deleteOne({ _id: "first-admin" });
    },

    async createAuthSession(session) {
      if (!this.isConnected()) throw new Error("MongoDB session storage is not connected.");
      await authSessionModel.create(session);
    },

    async findAuthSession(tokenHash, now = new Date()) {
      if (!this.isConnected()) throw new Error("MongoDB session storage is not connected.");
      return authSessionModel.findOne({ tokenHash, expiresAt: { $gt: now } }).lean();
    },

    async deleteAuthSession(tokenHash) {
      if (!this.isConnected()) throw new Error("MongoDB session storage is not connected.");
      await authSessionModel.deleteOne({ tokenHash });
    },

    async listSessionsByCandidate(candidateId) {
      if (!this.isConnected()) throw new Error("MongoDB interview storage is not connected.");
      const records = await sessionModel
        .find({ candidateId }, { _id: 0, state: 1 })
        .sort({ startedAt: -1 })
        .lean();
      return records.map((record) => record.state).filter((state) => state?.sessionId);
    },

    async findSessionById(sessionId) {
      if (!this.isConnected()) throw new Error("MongoDB interview storage is not connected.");
      const record = await sessionModel.findOne({ sessionId }, { _id: 0, state: 1 }).lean();
      return record?.state || null;
    },

    async deleteSession(sessionId) {
      if (!this.isConnected()) throw new Error("MongoDB interview storage is not connected.");
      if (!sessionId || typeof sessionId !== "string") return false;
      const record = await sessionModel.findOne({ sessionId }, { state: 1 }).lean();
      if (!record) return false;
      if (connection.db && record.state?.reportPdfRef?.fileId) {
        try {
          const bucket = gridFsBucketFactory(connection.db);
          await bucket.delete(new mongoose.Types.ObjectId(record.state.reportPdfRef.fileId)).catch(() => {});
        } catch {}
      }
      const result = await sessionModel.deleteOne({ sessionId });
      return result.deletedCount > 0;
    },

    async getOrCreateReportPdf({ sessionId, reportHash, filename, generatePdf }) {
      if (!this.isConnected() || !connection.db) throw new Error("MongoDB report storage is not connected.");
      const writeKey = `${sessionId}:${reportHash}`;
      if (reportPdfWrites.has(writeKey)) return reportPdfWrites.get(writeKey);
      const operation = (async () => {
        const record = await sessionModel.findOne({ sessionId }, { state: 1 }).lean();
        if (!record?.state) return null;
        const bucket = gridFsBucketFactory(connection.db);
        const previousRef = record.state.reportPdfRef;
        if (previousRef?.reportHash === reportHash && previousRef.fileId) {
          try {
            const buffer = await readGridFsFile(bucket, previousRef.fileId);
            return { buffer, fileId: previousRef.fileId, filename };
          } catch (error) {
            if (error?.code !== "ENOENT" && error?.codeName !== "FileNotFound") throw error;
          }
        }

        const buffer = await generatePdf();
        const upload = bucket.openUploadStream(filename, {
          contentType: "application/pdf",
          metadata: { sessionId, reportHash },
        });
        await new Promise((resolve, reject) => {
          upload.on("error", reject);
          upload.on("finish", resolve);
          upload.end(buffer);
        });
        const fileId = upload.id.toString();
        await sessionModel.updateOne(
          { sessionId },
          { $set: { "state.reportPdfRef": { fileId, reportHash, filename } } },
        );
        if (previousRef?.fileId) {
          await bucket.delete(new mongoose.Types.ObjectId(previousRef.fileId)).catch(() => {});
        }
        return { buffer, fileId, filename };
      })();
      reportPdfWrites.set(writeKey, operation);
      try {
        return await operation;
      } finally {
        if (reportPdfWrites.get(writeKey) === operation) reportPdfWrites.delete(writeKey);
      }
    },
  };
}

module.exports = {
  createPersistence,
  persistence: createPersistence(),
  InterviewSession,
  Candidate,
  Admin,
  AuthSession,
  AdminBootstrap,
};
