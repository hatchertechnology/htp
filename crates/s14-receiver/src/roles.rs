//! Explicit decision model, not installed GRANT/RLS/trigger or admission code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Principal {
    Anon,
    Authenticated,
    ServiceRole,
    Ingress,
    ProofWriter,
    CommitOwner,
    GuardOwner,
    Operator,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Preflight,
    PersistProof,
    CommitWorker,
    ReleaseSlot,
    Activate,
    DirectSchema4Insert,
}
#[must_use]
pub fn may_execute(who: Principal, operation: Operation) -> bool {
    matches!(
        (who, operation),
        (
            Principal::Ingress,
            Operation::Preflight | Operation::CommitWorker | Operation::ReleaseSlot
        ) | (Principal::ProofWriter, Operation::PersistProof)
            | (Principal::Operator, Operation::Activate)
            | (Principal::CommitOwner, Operation::DirectSchema4Insert)
    )
}
/// A SQL grant alone is insufficient for a nonowner NOBYPASSRLS identity.
#[must_use]
pub fn row_access(sql_grant: bool, explicit_rls_policy_allows: bool) -> bool {
    sql_grant && explicit_rls_policy_allows
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WorkerScope {
    #[default]
    Unavailable,
    Current,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionFence {
    #[default]
    Lost,
    Live,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Gate {
    #[default]
    Off,
    On,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Revision {
    #[default]
    Disallowed,
    Approved,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Proof {
    #[default]
    Unavailable,
    ScopedUnexpired,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Context {
    pub worker: WorkerScope,
    pub session: SessionFence,
    pub api: Gate,
    pub db: Gate,
    pub revision: Revision,
    pub proof: Proof,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Denied,
    PriorCommitReceipt,
    NewInsertModelOnly,
}
#[must_use]
pub fn decide(context: Context, committed_exact: bool) -> Decision {
    if context.worker != WorkerScope::Current || context.session != SessionFence::Live {
        return Decision::Denied;
    }
    if committed_exact {
        return Decision::PriorCommitReceipt;
    }
    if context.api == Gate::On
        && context.db == Gate::On
        && context.revision == Revision::Approved
        && context.proof == Proof::ScopedUnexpired
    {
        Decision::NewInsertModelOnly
    } else {
        Decision::Denied
    }
}
