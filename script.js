const cfoTaskControlCenterDB = "cfoTaskControlCenterDB";
const CURRENT_DB_VERSION = "0.1.0";
const AUDIT_LOG_LIMIT = 1500;

const BASE_CATEGORIES = [
  "Бюджетирование",
  "Казначейство",
  "Управленческая отчетность",
  "Налоги",
  "Аудит",
  "Риски",
  "Закупки",
  "Дебиторская задолженность",
  "Кредиторская задолженность",
  "Стратегия",
  "Комплаенс"
];

const STATUS_OPTIONS = ["backlog", "todo", "in_progress", "waiting", "review", "done", "blocked"];
const KANBAN_COLUMNS = [
  "backlog",
  "in_progress",
  "review",
  "waiting",
  "done",
  "blocked"
];
const PRIORITY_OPTIONS = ["P1", "P2", "P3"];
const TASK_TYPE_OPTIONS = ["operational", "strategic", "control", "delegated", "risk"];
const RISK_LEVEL_OPTIONS = ["low", "medium", "high", "critical"];
const RISK_TYPE_OPTIONS = ["none", "tax", "legal", "operational", "financial", "customs", "warehouse"];
const RECURRENCE_RULE_OPTIONS = ["none", "daily", "weekly", "monthly", "quarterly", "yearly"];
const RECURRENCE_RULE_LABELS = {
  none: "Нет",
  daily: "Ежедневно",
  weekly: "Еженедельно",
  monthly: "Ежемесячно",
  quarterly: "Ежеквартально",
  yearly: "Ежегодно"
};
const RISK_TYPE_LABELS = {
  none: "Нет риска",
  tax: "Налоговый",
  legal: "Юридический",
  operational: "Операционный",
  financial: "Финансовый",
  customs: "ВЭД/таможня",
  warehouse: "Склад"
};
const PRIORITY_SCORE = { P1: 50, P2: 30, P3: 10 };
const URGENCY_SCORE = { overdue: 50, today: 40, tomorrow: 20, future: 0 };
const RISK_SCORE = { critical: 40, high: 30, medium: 15, low: 5 };
const PRIORITY_SORT = { P1: 1, P2: 2, P3: 3 };

const TASK_DEFAULTS = {
  id: "",
  title: "",
  description: "",
  category: "Бюджетирование",
  status: "backlog",
  priority: "P3",
  taskType: "operational",
  riskType: "none",
  riskLevel: "medium",
  dueDate: "",
  owner: "CFO Office",
  delegate: "",
  delegationDate: "",
  responseDueDate: "",
  nextAction: "",
  isCeoFocus: false,
  isRecurring: false,
  recurringRule: "none",
  recurrenceRule: "none",
  createdAt: "",
  updatedAt: "",
  completedAt: "",
  impact: "medium",
  effort: "medium",
  tags: [],
  comments: []
};

let appDB = null;
let activeModalTaskId = null;
let originalModalTask = null;
const taskListState = {
  search: "",
  filters: {
    status: "",
    category: "",
    priority: "",
    taskType: "",
    riskLevel: ""
  },
  quickFilters: {
    overdueOnly: false,
    todayOnly: false,
    ceoOnly: false,
    delegatedOnly: false,
    hideDone: true
  },
  sort: {
    field: "",
    direction: "asc"
  }
};

function generateId(prefix) {
  const randomPart = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
  return `${prefix}_${Date.now()}_${randomPart}`;
}

function createDefaultDB() {
  return {
    version: CURRENT_DB_VERSION,
    tasks: [],
    auditLog: [],
    categories: [...BASE_CATEGORIES]
  };
}

function isQuotaExceededError(error) {
  return Boolean(
    error &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22 ||
      error.code === 1014)
  );
}

function compactAuditLogForQuota(db) {
  const taskPriorityById = new Map(db.tasks.map((task) => [task.id, task.priority]));
  const compactedLog = db.auditLog.filter((entry) => {
    const priority = taskPriorityById.get(entry.taskId);
    return priority !== "P2" && priority !== "P3";
  });

  db.auditLog = compactedLog.length < db.auditLog.length
    ? compactedLog.slice(-AUDIT_LOG_LIMIT)
    : db.auditLog.slice(Math.max(0, db.auditLog.length - Math.floor(AUDIT_LOG_LIMIT / 2)));
}

function saveDB(db) {
  try {
    localStorage.setItem(cfoTaskControlCenterDB, JSON.stringify(db));
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      showToast("ошибка сохранения базы. проверьте доступ к LocalStorage", "error");
      return false;
    }

    compactAuditLogForQuota(db);

    try {
      localStorage.setItem(cfoTaskControlCenterDB, JSON.stringify(db));
      showToast("журнал сокращен из-за лимита LocalStorage", "info");
      return true;
    } catch (retryError) {
      showToast("локальное хранилище переполнено. сделайте экспорт базы", "error");
      return false;
    }
  }
}

function createAuditEvent(action, taskId, changes, reason) {
  const logId = generateId("log");

  return {
    id: logId,
    logId,
    action,
    taskId: taskId || "",
    changes: changes || {},
    reason: reason || "",
    timestamp: new Date().toISOString()
  };
}

function addAuditLog(action, taskId, changes, reason) {
  appDB.auditLog.push(createAuditEvent(action, taskId, changes, reason));

  if (appDB.auditLog.length > AUDIT_LOG_LIMIT) {
    appDB.auditLog = appDB.auditLog.slice(appDB.auditLog.length - AUDIT_LOG_LIMIT);
  }
}

function mergeCategories(categories) {
  const sourceCategories = Array.isArray(categories) ? categories : [];
  return Array.from(new Set([...sourceCategories, ...BASE_CATEGORIES]));
}

function normalizeAuditEntry(entry) {
  const logId = entry.logId || entry.id || generateId("log");

  return {
    ...entry,
    id: entry.id || logId,
    logId,
    timestamp: entry.timestamp || entry.createdAt || new Date().toISOString()
  };
}

function normalizeTask(task) {
  const normalized = {
    ...TASK_DEFAULTS,
    ...task
  };

  normalized.id = normalized.id || generateId("task");
  normalized.isCeoFocus = Boolean(task.isCeoFocus ?? task.ceoFocus ?? false);
  normalized.isRecurring = Boolean(task.isRecurring);
  normalized.recurringRule = task.recurringRule || task.recurrenceRule || "none";
  normalized.recurrenceRule = normalized.recurringRule;
  normalized.createdAt = normalized.createdAt || new Date().toISOString();
  normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
  normalized.tags = Array.isArray(normalized.tags) ? normalized.tags : [];
  normalized.comments = Array.isArray(normalized.comments) ? normalized.comments : [];

  delete normalized.ceoFocus;

  return normalized;
}

function migrateDB(db) {
  const source = db && typeof db === "object" ? db : createDefaultDB();
  const migrated = {
    ...createDefaultDB(),
    ...source,
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    auditLog: Array.isArray(source.auditLog) ? source.auditLog.map(normalizeAuditEntry) : [],
    categories: mergeCategories(source.categories)
  };
  const before = JSON.stringify(migrated.tasks);

  migrated.tasks = migrated.tasks.map(normalizeTask);

  if (migrated.version !== CURRENT_DB_VERSION || before !== JSON.stringify(migrated.tasks)) {
    migrated.version = CURRENT_DB_VERSION;
    migrated.auditLog.push(createAuditEvent(
      "migration",
      "",
      { version: CURRENT_DB_VERSION },
      "Структура базы данных обновлена до версии 0.1.0"
    ));
  }

  if (migrated.auditLog.length > AUDIT_LOG_LIMIT) {
    migrated.auditLog = migrated.auditLog.slice(migrated.auditLog.length - AUDIT_LOG_LIMIT);
  }

  return migrated;
}

function loadDB() {
  const rawDB = localStorage.getItem(cfoTaskControlCenterDB);

  if (!rawDB) {
    const defaultDB = createDefaultDB();
    saveDB(defaultDB);
    return defaultDB;
  }

  try {
    const parsedDB = JSON.parse(rawDB);
    const migratedDB = migrateDB(parsedDB);
    const recurringCreatedCount = processRecurringTasks(migratedDB);

    if (recurringCreatedCount || JSON.stringify(parsedDB) !== JSON.stringify(migratedDB)) {
      saveDB(migratedDB);
    }

    return migratedDB;
  } catch (error) {
    const defaultDB = createDefaultDB();
    defaultDB.auditLog.push(createAuditEvent(
      "initialization",
      "",
      {},
      "Хранилище было пересоздано после ошибки чтения JSON"
    ));
    saveDB(defaultDB);
    return defaultDB;
  }
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function getDateStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDateStart(dateValue) {
  if (!dateValue) {
    return null;
  }

  const [year, month, day] = dateValue.split("-").map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addRecurringInterval(date, rule) {
  if (rule === "daily") {
    return parseDateStart(addDays(date, 1));
  }

  if (rule === "weekly") {
    return parseDateStart(addDays(date, 7));
  }

  if (rule === "monthly") {
    return addMonths(date, 1);
  }

  if (rule === "quarterly") {
    return addMonths(date, 3);
  }

  if (rule === "yearly") {
    return addMonths(date, 12);
  }

  return null;
}

function calculateNextRecurringDate(task) {
  const rule = task.recurringRule || task.recurrenceRule || "none";
  const dueDate = parseDateStart(task.dueDate);

  if (!task.isRecurring || rule === "none" || !dueDate) {
    return "";
  }

  let nextDate = addRecurringInterval(dueDate, rule);
  const today = getDateStart(new Date());

  while (nextDate && nextDate < today) {
    nextDate = addRecurringInterval(nextDate, rule);
  }

  return nextDate ? formatDateInput(nextDate) : "";
}

function shouldCreateRecurringInstance(task) {
  const rule = task.recurringRule || task.recurrenceRule || "none";
  const dueDate = parseDateStart(task.dueDate);
  const firstNextDate = dueDate ? addRecurringInterval(dueDate, rule) : null;

  return Boolean(
    task.isRecurring &&
    rule !== "none" &&
    firstNextDate &&
    firstNextDate <= getDateStart(new Date())
  );
}

function processRecurringTasks(db) {
  const now = new Date().toISOString();
  let createdCount = 0;

  db.tasks
    .filter((task) => task.isRecurring && (task.recurringRule || task.recurrenceRule || "none") !== "none")
    .forEach((task) => {
      if (!shouldCreateRecurringInstance(task)) {
        return;
      }

      const nextDueDate = calculateNextRecurringDate(task);

      if (!nextDueDate) {
        return;
      }

      const duplicate = db.tasks.some((candidate) => (
        candidate.title === task.title &&
        candidate.dueDate === nextDueDate
      ));

      if (duplicate) {
        return;
      }

      const recurringTask = normalizeTask({
        ...task,
        id: generateId("task"),
        status: "backlog",
        dueDate: nextDueDate,
        isRecurring: false,
        recurringRule: "none",
        recurrenceRule: "none",
        completedAt: "",
        createdAt: now,
        updatedAt: now
      });

      db.tasks.push(recurringTask);
      db.auditLog.push(createAuditEvent("recurring_created", recurringTask.id, {
        sourceTaskId: task.id,
        dueDate: nextDueDate
      }, "Создан экземпляр повторяющейся задачи"));
      createdCount += 1;
    });

  if (db.auditLog.length > AUDIT_LOG_LIMIT) {
    db.auditLog = db.auditLog.slice(db.auditLog.length - AUDIT_LOG_LIMIT);
  }

  return createdCount;
}

function getDayDiff(fromDate, toDate) {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((getDateStart(toDate) - getDateStart(fromDate)) / dayMs);
}

function isActiveTask(task) {
  return task.status !== "done";
}

function calculateOverdueDays(task) {
  const dueDate = parseDateStart(task.dueDate);

  if (!dueDate || !isActiveTask(task)) {
    return 0;
  }

  return Math.max(0, getDayDiff(dueDate, new Date()));
}

function calculateUrgency(task) {
  const dueDate = parseDateStart(task.dueDate);

  if (!dueDate || !isActiveTask(task)) {
    return "future";
  }

  const daysUntilDue = getDayDiff(new Date(), dueDate);

  if (daysUntilDue < 0) {
    return "overdue";
  }

  if (daysUntilDue === 0) {
    return "today";
  }

  if (daysUntilDue === 1) {
    return "tomorrow";
  }

  return "future";
}

function calculateWaitingDays(task) {
  if (task.status !== "waiting") {
    return 0;
  }

  const startDate = parseDateStart(task.delegationDate) || parseDateStart(task.createdAt?.slice(0, 10));

  if (!startDate) {
    return 0;
  }

  return Math.max(0, getDayDiff(startDate, new Date()));
}

function isWaitingResponseOverdue(task) {
  const responseDueDate = parseDateStart(task.responseDueDate);

  return Boolean(
    task.status === "waiting" &&
    responseDueDate &&
    getDayDiff(responseDueDate, new Date()) > 0
  );
}

function calculateTaskScore(task) {
  if (!isActiveTask(task)) {
    return 0;
  }

  const priorityPoints = PRIORITY_SCORE[task.priority] || 0;
  const urgencyPoints = URGENCY_SCORE[calculateUrgency(task)] || 0;
  const riskPoints = RISK_SCORE[task.riskLevel] || 0;
  const ceoPoints = task.isCeoFocus ? 30 : 0;
  const waitingPoints = task.status === "waiting"
    ? (isWaitingResponseOverdue(task) ? 20 : 10)
    : 0;

  return priorityPoints + urgencyPoints + riskPoints + ceoPoints + waitingPoints;
}

function compareTasksByScore(taskA, taskB) {
  const scoreDiff = calculateTaskScore(taskB) - calculateTaskScore(taskA);

  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const priorityDiff = (PRIORITY_SORT[taskA.priority] || 99) - (PRIORITY_SORT[taskB.priority] || 99);

  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const dateA = parseDateStart(taskA.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const dateB = parseDateStart(taskB.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;

  if (dateA !== dateB) {
    return dateA - dateB;
  }

  return Number(taskB.isCeoFocus) - Number(taskA.isCeoFocus);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderOptions(options, selectedValue) {
  return options.map((option) => (
    `<option value="${escapeHTML(option)}"${option === selectedValue ? " selected" : ""}>${escapeHTML(option)}</option>`
  )).join("");
}

function renderLabeledOptions(options, selectedValue, labels) {
  return options.map((option) => (
    `<option value="${escapeHTML(option)}"${option === selectedValue ? " selected" : ""}>${escapeHTML(labels[option] || option)}</option>`
  )).join("");
}

function createDemoTasks() {
  const now = new Date();
  const createdAt = now.toISOString();

  return [
    {
      title: "Закрыть платежный календарь на неделю",
      description: "Сверить остатки, платежи и лимиты по операционным счетам.",
      category: "Казначейство",
      priority: "P1",
      status: "in_progress",
      taskType: "operational",
      riskType: "financial",
      owner: "Финансовый контролер",
      dueDate: addDays(now, 2),
      riskLevel: "high",
      nextAction: "Подтвердить лимиты платежей",
      tags: ["cash-flow", "weekly"]
    },
    {
      title: "Подготовить CEO-сводку по EBITDA",
      description: "Собрать отклонения факта от плана и выделить драйверы маржи.",
      category: "Управленческая отчетность",
      priority: "P1",
      status: "todo",
      taskType: "strategic",
      riskType: "financial",
      owner: "CFO",
      dueDate: addDays(now, 1),
      isCeoFocus: true,
      riskLevel: "high",
      nextAction: "Согласовать тезисы с CEO",
      tags: ["ceo-focus", "ebitda"]
    },
    {
      title: "Получить подтверждение по банковской гарантии",
      description: "Ожидается ответ от банка и юридического блока.",
      category: "Риски",
      priority: "P2",
      status: "waiting",
      taskType: "delegated",
      riskType: "legal",
      owner: "Казначей",
      delegate: "Юридический департамент",
      delegationDate: addDays(now, -1),
      responseDueDate: addDays(now, 2),
      dueDate: addDays(now, 4),
      riskLevel: "medium",
      nextAction: "Получить позицию юристов",
      tags: ["waiting", "bank"]
    },
    {
      title: "Актуализировать прогноз ДДС",
      description: "Обновить прогноз поступлений и платежей на 13 недель.",
      category: "Бюджетирование",
      priority: "P2",
      status: "review",
      taskType: "control",
      riskType: "operational",
      owner: "FP&A менеджер",
      dueDate: addDays(now, 3),
      riskLevel: "medium",
      nextAction: "Проверить сценарии",
      tags: ["forecast"]
    },
    {
      title: "Согласовать налоговый календарь",
      description: "Проверить сроки подачи деклараций и платежей.",
      category: "Налоги",
      priority: "P3",
      status: "done",
      taskType: "control",
      riskType: "tax",
      owner: "Налоговый менеджер",
      dueDate: addDays(now, -2),
      completedAt: createdAt,
      riskLevel: "low",
      nextAction: "Архивировать подтверждение",
      tags: ["tax"]
    },
    {
      title: "Разобрать просроченную дебиторскую задолженность",
      description: "Сформировать список контрагентов с просрочкой более 30 дней.",
      category: "Дебиторская задолженность",
      priority: "P1",
      status: "todo",
      taskType: "risk",
      riskType: "financial",
      owner: "AR lead",
      dueDate: addDays(now, -1),
      riskLevel: "critical",
      nextAction: "Запустить обзвон должников",
      tags: ["overdue", "ar"]
    },
    {
      title: "Проверить реестр кредиторской задолженности",
      description: "Сверить обязательства с графиком платежей.",
      category: "Кредиторская задолженность",
      priority: "P2",
      status: "backlog",
      taskType: "operational",
      riskType: "none",
      owner: "AP lead",
      dueDate: addDays(now, 6),
      riskLevel: "medium",
      nextAction: "Сверить крупные платежи",
      tags: ["ap"]
    },
    {
      title: "Подготовить материалы для аудита",
      description: "Собрать первичные документы и контрольные расшифровки.",
      category: "Аудит",
      priority: "P2",
      status: "in_progress",
      taskType: "control",
      riskType: "operational",
      owner: "Главный бухгалтер",
      dueDate: addDays(now, 7),
      riskLevel: "medium",
      nextAction: "Передать выборку аудиторам",
      tags: ["audit"]
    },
    {
      title: "Оценить экономию по закупочному тендеру",
      description: "Сравнить коммерческие предложения и влияние на бюджет.",
      category: "Закупки",
      priority: "P3",
      status: "review",
      taskType: "operational",
      riskType: "customs",
      owner: "Procurement finance",
      dueDate: addDays(now, 5),
      riskLevel: "low",
      nextAction: "Проверить baseline",
      tags: ["procurement"]
    },
    {
      title: "Обновить финансовые KPI стратегии",
      description: "Проверить целевые метрики и статус инициатив квартала.",
      category: "Стратегия",
      priority: "P3",
      status: "backlog",
      taskType: "strategic",
      riskType: "warehouse",
      owner: "Strategy finance",
      dueDate: addDays(now, 10),
      riskLevel: "low",
      isRecurring: true,
      recurrenceRule: "monthly",
      nextAction: "Обновить KPI-файл",
      tags: ["strategy", "kpi"]
    }
  ].map((task) => normalizeTask({
    ...task,
    id: generateId("task"),
    createdAt,
    updatedAt: createdAt
  }));
}

function showToast(message, type = "info") {
  const toastRoot = document.querySelector("#toast-root");
  const safeType = ["success", "error", "info"].includes(type) ? type : "info";

  if (!toastRoot) {
    return;
  }

  toastRoot.innerHTML = `<div class="toast ${safeType}">${escapeHTML(message)}</div>`;
  window.setTimeout(() => {
    toastRoot.innerHTML = "";
  }, 2600);
}

function setMetricValue(metricName, value) {
  const metricValue = document.querySelector(`[data-metric="${metricName}"] strong`);

  if (metricValue) {
    metricValue.textContent = String(value).padStart(2, "0");
  }
}

function getTaskMeta(task, extraText) {
  const parts = [
    escapeHTML(task.priority),
    escapeHTML(task.status),
    escapeHTML(task.dueDate || "без даты"),
    escapeHTML(task.riskLevel)
  ];

  if (task.status === "waiting") {
    parts.push(`waiting ${calculateWaitingDays(task)} дн.`);
  }

  if (extraText) {
    parts.push(extraText);
  }

  return parts.join(" / ");
}

function getDashboardTaskHTML(task, options = {}) {
  const score = calculateTaskScore(task);
  const overdueDays = calculateOverdueDays(task);
  const itemClasses = [
    "priority-item",
    overdueDays > 0 ? "is-overdue" : "",
    task.isCeoFocus ? "is-ceo" : ""
  ].filter(Boolean).join(" ");
  const overdueLabel = overdueDays > 0
    ? `<span class="overdue-days">просрочено ${overdueDays} дн.</span>`
    : "";
  const ceoLabel = task.isCeoFocus
    ? `<span class="ceo-bolt">⚡ CEO</span>`
    : "";
  const extraMeta = [overdueLabel, ceoLabel, options.extraMeta || ""].filter(Boolean).join(" / ");

  return `
    <article class="${itemClasses}">
      <div>
        <p class="priority-title">${escapeHTML(task.title)}</p>
        <span class="priority-meta">${getTaskMeta(task, extraMeta)}</span>
      </div>
      <div class="priority-score">
        <span class="score-value">${score}</span>
        score
      </div>
    </article>
  `;
}

function renderList(rootSelector, tasks, emptyText, options = {}) {
  const root = document.querySelector(rootSelector);

  if (!root) {
    return;
  }

  if (!tasks.length) {
    root.innerHTML = `<div class="list-empty">${escapeHTML(emptyText)}</div>`;
    return;
  }

  root.innerHTML = tasks.map((task) => getDashboardTaskHTML(task, options)).join("");
}

function renderDashboard() {
  const activeTasks = appDB.tasks.filter(isActiveTask);
  const todayTasks = activeTasks.filter((task) => calculateUrgency(task) === "today");
  const overdueTasks = activeTasks.filter((task) => calculateOverdueDays(task) > 0);
  const riskTasks = activeTasks.filter((task) => (
    ["high", "critical"].includes(task.riskLevel) || task.status === "blocked"
  ));
  const p1Tasks = activeTasks.filter((task) => task.priority === "P1");
  const ceoTasks = activeTasks.filter((task) => task.isCeoFocus);
  const topTasks = [...activeTasks]
    .sort(compareTasksByScore)
    .slice(0, 5);
  const sortedOverdueTasks = [...overdueTasks].sort((taskA, taskB) => {
    const priorityDiff = (PRIORITY_SORT[taskA.priority] || 99) - (PRIORITY_SORT[taskB.priority] || 99);

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return calculateOverdueDays(taskB) - calculateOverdueDays(taskA);
  });
  const sortedCeoTasks = [...ceoTasks].sort(compareTasksByScore);

  setMetricValue("active", activeTasks.length);
  setMetricValue("today", todayTasks.length);
  setMetricValue("overdue", overdueTasks.length);
  setMetricValue("risk", riskTasks.length);
  setMetricValue("p1", p1Tasks.length);
  setMetricValue("ceo", ceoTasks.length);

  renderList("#today-priority-list", topTasks, "Нет активных задач для расчета приоритета.");
  renderList("#overdue-list", sortedOverdueTasks, "Просроченных активных задач нет.");
  renderList("#ceo-focus-list", sortedCeoTasks, "Активных задач CEO-фокуса нет.");
}

function renderDBSummary() {
  const totalTasks = appDB.tasks.length;
  const ceoTasks = appDB.tasks.filter((task) => task.isCeoFocus && isActiveTask(task)).length;
  const waitingTasks = appDB.tasks.filter((task) => task.status === "waiting").length;
  const settingsCopy = document.querySelector(".panel-copy");

  if (settingsCopy) {
    settingsCopy.textContent = `Версия БД: ${appDB.version}. Задач: ${totalTasks}. CEO-фокус: ${ceoTasks}. Waiting: ${waitingTasks}. AuditLog: ${appDB.auditLog.length}.`;
  }
}

function renderTaskTable() {
  const tableBody = document.querySelector("#task-table-body");
  const emptyState = document.querySelector("#task-empty-state");

  if (!tableBody || !emptyState) {
    return;
  }

  const visibleTasks = getVisibleTaskList();

  emptyState.classList.toggle("is-visible", visibleTasks.length === 0);
  emptyState.textContent = visibleTasks.length === 0
    ? "По выбранным условиям задачи не найдены."
    : "";
  tableBody.innerHTML = visibleTasks.map((task) => `
    <tr data-task-id="${escapeHTML(task.id)}">
      <td class="task-title-cell">
        ${escapeHTML(task.title)}
        <span class="task-meta">${escapeHTML(task.description || "Нет описания")}</span>
      </td>
      <td>${escapeHTML(task.category)}</td>
      <td>${escapeHTML(task.status)}</td>
      <td>${escapeHTML(task.priority)}</td>
      <td>${escapeHTML(task.dueDate)}</td>
      <td>${escapeHTML(getUrgencyLabel(task))}</td>
      <td>${escapeHTML(task.riskLevel)}</td>
      <td>${escapeHTML(task.owner)}</td>
      <td>${escapeHTML(task.delegate || task.delegatee || "")}</td>
      <td>${escapeHTML(task.nextAction)}</td>
      <td>${task.isCeoFocus ? '<span class="ceo-bolt">⚡ YES</span>' : "NO"}</td>
      <td>${escapeHTML(task.updatedAt ? task.updatedAt.slice(0, 16).replace("T", " ") : "")}</td>
    </tr>
  `).join("");
  renderSortButtons();
}

function getOwnerInitials(owner) {
  const words = String(owner || "CFO")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() || "")
    .join("") || "CF";
}

function getKanbanCardHTML(task) {
  const priorityClass = task.priority.toLowerCase();
  const isResponseOverdue = isWaitingResponseOverdue(task);
  const waitingText = task.status === "waiting"
    ? `<span class="${isResponseOverdue ? "waiting-counter" : ""}">${calculateWaitingDays(task)} дн. ожидания</span>`
    : "";
  const cardClasses = [
    "kanban-card",
    isResponseOverdue ? "is-response-overdue" : ""
  ].filter(Boolean).join(" ");

  return `
    <article class="${cardClasses}" draggable="true" tabindex="0" data-task-id="${escapeHTML(task.id)}">
      <p class="kanban-card-title">${task.isCeoFocus ? '<span class="ceo-bolt">⚡</span> ' : ""}${escapeHTML(task.title)}</p>
      <span class="kanban-card-category">${escapeHTML(task.category)}</span>
      <div class="kanban-card-meta">
        <span class="priority-badge ${escapeHTML(priorityClass)}">${escapeHTML(task.priority)}</span>
        <span>${escapeHTML(task.dueDate || "без даты")}</span>
      </div>
      <div class="kanban-card-footer">
        <span class="owner-chip">
          <span class="owner-avatar">${escapeHTML(getOwnerInitials(task.owner))}</span>
          <span class="kanban-owner">${escapeHTML(task.owner || "CFO Office")}</span>
        </span>
        ${waitingText}
      </div>
    </article>
  `;
}

function renderKanbanBoard() {
  KANBAN_COLUMNS.forEach((status) => {
    const dropzone = document.querySelector(`[data-drop-status="${status}"]`);
    const count = document.querySelector(`[data-kanban-count="${status}"]`);
    const tasks = appDB.tasks
      .filter((task) => task.status === status || (status === "backlog" && task.status === "todo"))
      .sort(compareTasksByScore);

    if (dropzone) {
      dropzone.innerHTML = tasks.length
        ? tasks.map(getKanbanCardHTML).join("")
        : '<div class="list-empty">Нет задач</div>';
    }

    if (count) {
      count.textContent = tasks.length;
    }
  });
}

function getSelectOptionsHTML(options, selectedValue) {
  return '<option value="">Все</option>' + options.map((option) => (
    `<option value="${escapeHTML(option)}"${option === selectedValue ? " selected" : ""}>${escapeHTML(option)}</option>`
  )).join("");
}

function renderTaskFilterOptions() {
  const statusSelect = document.querySelector("#filter-status");
  const categorySelect = document.querySelector("#filter-category");
  const prioritySelect = document.querySelector("#filter-priority");
  const taskTypeSelect = document.querySelector("#filter-task-type");
  const riskSelect = document.querySelector("#filter-risk");

  if (statusSelect) {
    statusSelect.innerHTML = getSelectOptionsHTML(STATUS_OPTIONS, taskListState.filters.status);
  }

  if (categorySelect) {
    categorySelect.innerHTML = getSelectOptionsHTML(appDB.categories, taskListState.filters.category);
  }

  if (prioritySelect) {
    prioritySelect.innerHTML = getSelectOptionsHTML(PRIORITY_OPTIONS, taskListState.filters.priority);
  }

  if (taskTypeSelect) {
    taskTypeSelect.innerHTML = getSelectOptionsHTML(TASK_TYPE_OPTIONS, taskListState.filters.taskType);
  }

  if (riskSelect) {
    riskSelect.innerHTML = getSelectOptionsHTML(RISK_LEVEL_OPTIONS, taskListState.filters.riskLevel);
  }
}

function syncTaskFilterControls() {
  const searchInput = document.querySelector("#task-search");

  if (searchInput) {
    searchInput.value = taskListState.search;
  }

  Object.entries(taskListState.quickFilters).forEach(([filterName, value]) => {
    const checkbox = document.querySelector(`[data-quick-filter="${filterName}"]`);

    if (checkbox) {
      checkbox.checked = value;
    }
  });
}

function taskMatchesSearch(task) {
  const query = taskListState.search.trim().toLowerCase();

  if (!query) {
    return true;
  }

  return [
    task.title,
    task.description,
    task.category,
    task.owner,
    task.delegatee,
    task.delegate,
    task.nextAction
  ].some((value) => String(value || "").toLowerCase().includes(query));
}

function taskMatchesFilters(task) {
  const { filters, quickFilters } = taskListState;

  if (quickFilters.hideDone && task.status === "done") {
    return false;
  }

  if (filters.status && task.status !== filters.status) {
    return false;
  }

  if (filters.category && task.category !== filters.category) {
    return false;
  }

  if (filters.priority && task.priority !== filters.priority) {
    return false;
  }

  if (filters.taskType && task.taskType !== filters.taskType) {
    return false;
  }

  if (filters.riskLevel && task.riskLevel !== filters.riskLevel) {
    return false;
  }

  if (quickFilters.overdueOnly && calculateOverdueDays(task) <= 0) {
    return false;
  }

  if (quickFilters.todayOnly && calculateUrgency(task) !== "today") {
    return false;
  }

  if (quickFilters.ceoOnly && !task.isCeoFocus) {
    return false;
  }

  if (quickFilters.delegatedOnly && !(task.delegate || task.delegatee)) {
    return false;
  }

  return taskMatchesSearch(task);
}

function compareTaskListValues(taskA, taskB) {
  const { field, direction } = taskListState.sort;

  if (!field) {
    return 0;
  }

  let result = 0;

  if (field === "priority") {
    result = (PRIORITY_SORT[taskA.priority] || 99) - (PRIORITY_SORT[taskB.priority] || 99);
  }

  if (field === "dueDate") {
    const dateA = parseDateStart(taskA.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const dateB = parseDateStart(taskB.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    result = dateA - dateB;
  }

  if (field === "updatedAt") {
    const dateA = Date.parse(taskA.updatedAt || "") || 0;
    const dateB = Date.parse(taskB.updatedAt || "") || 0;
    result = dateA - dateB;
  }

  return direction === "desc" ? -result : result;
}

function getVisibleTaskList() {
  return appDB.tasks
    .filter(taskMatchesFilters)
    .sort(compareTaskListValues);
}

function getUrgencyLabel(task) {
  const urgency = calculateUrgency(task);
  const labels = {
    overdue: `Просрочено ${calculateOverdueDays(task)} дн.`,
    today: "Сегодня",
    tomorrow: "Завтра",
    future: "Будущее"
  };

  return labels[urgency] || urgency;
}

function renderSortButtons() {
  document.querySelectorAll("[data-sort-field]").forEach((button) => {
    const isActive = button.dataset.sortField === taskListState.sort.field;
    button.classList.toggle("is-active", isActive);
    button.classList.toggle("asc", isActive && taskListState.sort.direction === "asc");
    button.classList.toggle("desc", isActive && taskListState.sort.direction === "desc");
  });
}

function getMatrixQuadrant(task) {
  const urgency = calculateUrgency(task);
  const isUrgent = urgency === "overdue" || urgency === "today";
  const isImportant = task.priority === "P1";

  if (isImportant && isUrgent) {
    return "q1";
  }

  if (isImportant && !isUrgent) {
    return "q2";
  }

  if (!isImportant && isUrgent) {
    return "q3";
  }

  return "q4";
}

function getAnalyticsCardHTML(task) {
  const overdueDays = calculateOverdueDays(task);
  const overdueLabel = overdueDays > 0 ? ` / просрочено ${overdueDays} дн.` : "";
  const ceoLabel = task.isCeoFocus ? " / ⚡ CEO" : "";

  return `
    <article class="analytics-card" tabindex="0" data-task-id="${escapeHTML(task.id)}">
      <p class="analytics-card-title">${escapeHTML(task.title)}</p>
      <span class="analytics-card-meta">
        ${escapeHTML(task.priority)} / ${escapeHTML(calculateUrgency(task))} / ${escapeHTML(task.dueDate || "без даты")} / ${escapeHTML(task.riskLevel)}${overdueLabel}${ceoLabel}
      </span>
    </article>
  `;
}

function renderAnalyticsList(selector, tasks, emptyText) {
  const root = document.querySelector(selector);

  if (!root) {
    return;
  }

  root.innerHTML = tasks.length
    ? tasks.sort(compareTasksByScore).map(getAnalyticsCardHTML).join("")
    : `<div class="list-empty">${escapeHTML(emptyText)}</div>`;
}

function renderPriorityMatrix() {
  const quadrants = {
    q1: [],
    q2: [],
    q3: [],
    q4: []
  };

  appDB.tasks
    .filter(isActiveTask)
    .forEach((task) => {
      quadrants[getMatrixQuadrant(task)].push(task);
    });

  renderAnalyticsList('[data-matrix-list="q1"]', quadrants.q1, "Нет срочных важных задач.");
  renderAnalyticsList('[data-matrix-list="q2"]', quadrants.q2, "Нет важных задач вне срочного окна.");
  renderAnalyticsList('[data-matrix-list="q3"]', quadrants.q3, "Нет срочных задач P2/P3.");
  renderAnalyticsList('[data-matrix-list="q4"]', quadrants.q4, "Нет отложенных задач P2/P3.");
}

function getRiskHeaderHTML(riskType, tasks) {
  const p1Count = tasks.filter((task) => task.priority === "P1").length;
  const overdueCount = tasks.filter((task) => calculateOverdueDays(task) > 0).length;
  const criticalCount = tasks.filter((task) => task.riskLevel === "critical").length;

  return `
    <span>${escapeHTML(riskType)}</span>
    <strong>${escapeHTML(RISK_TYPE_LABELS[riskType] || riskType)}</strong>
    <div class="risk-counter-row">
      <span class="risk-counter"><b>${tasks.length}</b><small>Всего</small></span>
      <span class="risk-counter"><b>${p1Count}</b><small>P1</small></span>
      <span class="risk-counter"><b>${overdueCount}</b><small>Проср.</small></span>
      <span class="risk-counter"><b>${criticalCount}</b><small>Critical</small></span>
    </div>
  `;
}

function renderRiskMap() {
  RISK_TYPE_OPTIONS.forEach((riskType) => {
    const tasks = appDB.tasks
      .filter((task) => isActiveTask(task) && (task.riskType || "none") === riskType)
      .sort(compareTasksByScore);
    const section = document.querySelector(`[data-risk-type="${riskType}"]`);
    const list = document.querySelector(`[data-risk-list="${riskType}"]`);

    if (section) {
      section.querySelector(".risk-section-header").innerHTML = getRiskHeaderHTML(riskType, tasks);
    }

    if (list) {
      list.innerHTML = tasks.length
        ? tasks.map(getAnalyticsCardHTML).join("")
        : `<div class="list-empty">Активных задач нет.</div>`;
    }
  });
}

function getCriticalFinancialRiskTasks() {
  return appDB.tasks.filter((task) => (
    isActiveTask(task) &&
    task.priority === "P1" &&
    ["tax", "financial"].includes(task.riskType) &&
    ["overdue", "today"].includes(calculateUrgency(task))
  ));
}

function renderCriticalRiskBanner() {
  const root = document.querySelector("#critical-alert-root");

  if (!root) {
    return;
  }

  const criticalTasks = getCriticalFinancialRiskTasks();

  if (!criticalTasks.length) {
    root.innerHTML = "";
    return;
  }

  const preview = criticalTasks
    .slice(0, 3)
    .map((task) => task.title)
    .join("; ");

  root.innerHTML = `
    <div class="critical-alert" role="alert">
      <strong>Критический финансовый риск</strong>
      <span>P1 задачи с налоговым или финансовым риском требуют реакции сегодня. Найдено: ${criticalTasks.length}. ${escapeHTML(preview)}</span>
    </div>
  `;
}

function renderApp() {
  renderDashboard();
  renderDBSummary();
  renderTaskFilterOptions();
  syncTaskFilterControls();
  renderTaskTable();
  renderKanbanBoard();
  renderPriorityMatrix();
  renderRiskMap();
  renderCriticalRiskBanner();
}

function getTaskChanges(beforeTask, afterTask) {
  const changes = {};

  Object.keys(TASK_DEFAULTS).forEach((key) => {
    if (JSON.stringify(beforeTask[key]) !== JSON.stringify(afterTask[key])) {
      changes[key] = {
        from: beforeTask[key],
        to: afterTask[key]
      };
    }
  });

  return changes;
}

function getTaskFormTemplate(task, mode) {
  const title = mode === "create" ? "Создание задачи" : "Редактирование задачи";

  return `
    <div class="modal-overlay" data-action="close-modal">
      <section class="task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
        <div class="modal-header">
          <div>
            <p class="section-code">TASK CRUD</p>
            <h2 id="task-modal-title">${title}</h2>
          </div>
          <button class="compact-button" type="button" data-action="close-modal">Закрыть</button>
        </div>
        <form class="modal-form" id="task-form" novalidate>
          <div class="form-field span-2" data-field="title">
            <label for="task-title">Название *</label>
            <input id="task-title" name="title" value="${escapeHTML(task.title)}" autocomplete="off">
          </div>
          <div class="form-field" data-field="category">
            <label for="task-category">Категория *</label>
            <select id="task-category" name="category">
              ${renderOptions(appDB.categories, task.category)}
            </select>
          </div>
          <div class="form-field" data-field="status">
            <label for="task-status">Статус *</label>
            <select id="task-status" name="status">
              ${renderOptions(STATUS_OPTIONS, task.status)}
            </select>
          </div>
          <div class="form-field" data-field="priority">
            <label for="task-priority">Приоритет *</label>
            <select id="task-priority" name="priority">
              ${renderOptions(PRIORITY_OPTIONS, task.priority)}
            </select>
          </div>
          <div class="form-field">
            <label for="task-type">Тип</label>
            <select id="task-type" name="taskType">
              ${renderOptions(TASK_TYPE_OPTIONS, task.taskType)}
            </select>
          </div>
          <div class="form-field">
            <label for="task-risk-type">Тип риска</label>
            <select id="task-risk-type" name="riskType">
              ${renderLabeledOptions(RISK_TYPE_OPTIONS, task.riskType, RISK_TYPE_LABELS)}
            </select>
          </div>
          <div class="form-field">
            <label for="task-risk">Уровень риска</label>
            <select id="task-risk" name="riskLevel">
              ${renderOptions(RISK_LEVEL_OPTIONS, task.riskLevel)}
            </select>
          </div>
          <div class="form-field" data-field="dueDate">
            <label for="task-due-date">Дедлайн *</label>
            <input id="task-due-date" name="dueDate" type="date" value="${escapeHTML(task.dueDate)}">
          </div>
          <div class="form-field">
            <label for="task-owner">Владелец</label>
            <input id="task-owner" name="owner" value="${escapeHTML(task.owner)}" autocomplete="off">
          </div>
          <div class="form-field">
            <label for="task-delegate">Делегат</label>
            <input id="task-delegate" name="delegate" value="${escapeHTML(task.delegate)}" autocomplete="off">
          </div>
          <div class="form-field">
            <label for="task-delegation-date">Дата делегирования</label>
            <input id="task-delegation-date" name="delegationDate" type="date" value="${escapeHTML(task.delegationDate)}">
          </div>
          <div class="form-field">
            <label for="task-response-due-date">Срок ответа</label>
            <input id="task-response-due-date" name="responseDueDate" type="date" value="${escapeHTML(task.responseDueDate)}">
          </div>
          <div class="form-field span-4">
            <label for="task-description">Описание</label>
            <textarea id="task-description" name="description">${escapeHTML(task.description)}</textarea>
          </div>
          <div class="form-field span-4">
            <label for="task-next-action">Следующее действие</label>
            <textarea id="task-next-action" name="nextAction">${escapeHTML(task.nextAction)}</textarea>
          </div>
          <div class="form-field span-2">
            <label for="task-recurrence-rule">Правило повторения</label>
            <select id="task-recurrence-rule" name="recurringRule">
              ${renderLabeledOptions(RECURRENCE_RULE_OPTIONS, task.recurringRule, RECURRENCE_RULE_LABELS)}
            </select>
          </div>
          <div class="form-field span-2">
            <div class="checkbox-row">
              <label class="checkbox-field">
                <input name="isCeoFocus" type="checkbox"${task.isCeoFocus ? " checked" : ""}>
                CEO-фокус
              </label>
              <label class="checkbox-field">
                <input name="isRecurring" type="checkbox"${task.isRecurring ? " checked" : ""}>
                Повторение
              </label>
            </div>
          </div>
          <div class="form-field span-4 ceo-reason-field" data-field="dateShiftReason">
            <label for="date-shift-reason">Причина переноса дедлайна *</label>
            <textarea id="date-shift-reason" name="dateShiftReason"></textarea>
          </div>
        </form>
        <div class="modal-footer">
          ${mode === "edit" ? '<button class="danger-button" type="button" data-action="delete-task-modal">Удалить</button>' : ""}
          <button class="compact-button" type="button" data-action="close-modal">Отмена</button>
          <button class="action-button" id="save-task" type="submit" form="task-form">Сохранить</button>
        </div>
      </section>
    </div>
  `;
}

function openTaskModal(taskId) {
  const modalRoot = document.querySelector("#modal-root");
  const existingTask = taskId ? appDB.tasks.find((task) => task.id === taskId) : null;
  const mode = existingTask ? "edit" : "create";
  const task = normalizeTask(existingTask || {
    id: "",
    createdAt: "",
    updatedAt: "",
    dueDate: ""
  });

  activeModalTaskId = existingTask ? existingTask.id : null;
  originalModalTask = existingTask ? { ...existingTask } : null;
  modalRoot.innerHTML = getTaskFormTemplate(task, mode);

  const form = document.querySelector("#task-form");
  const overlay = document.querySelector(".modal-overlay");

  overlay.addEventListener("click", (event) => {
    if (event.target.dataset.action === "close-modal") {
      closeTaskModal();
    }

    if (event.target.dataset.action === "delete-task-modal" && activeModalTaskId) {
      const taskId = activeModalTaskId;
      closeTaskModal();
      deleteTask(taskId);
    }
  });
  form.addEventListener("input", updateCeoDateShiftState);
  form.addEventListener("change", updateCeoDateShiftState);
  form.addEventListener("submit", handleTaskFormSubmit);
  updateCeoDateShiftState();
  document.querySelector("#task-title").focus();
}

function closeTaskModal() {
  document.querySelector("#modal-root").innerHTML = "";
  activeModalTaskId = null;
  originalModalTask = null;
}

function getFormTaskData(form) {
  const formData = new FormData(form);

  return normalizeTask({
    id: activeModalTaskId || generateId("task"),
    title: formData.get("title").trim(),
    description: formData.get("description").trim(),
    category: formData.get("category"),
    status: formData.get("status"),
    priority: formData.get("priority"),
    taskType: formData.get("taskType"),
    riskType: formData.get("riskType"),
    riskLevel: formData.get("riskLevel"),
    dueDate: formData.get("dueDate"),
    owner: formData.get("owner").trim(),
    delegate: formData.get("delegate").trim(),
    delegationDate: formData.get("delegationDate"),
    responseDueDate: formData.get("responseDueDate"),
    nextAction: formData.get("nextAction").trim(),
    isCeoFocus: formData.get("isCeoFocus") === "on",
    isRecurring: formData.get("isRecurring") === "on",
    recurringRule: formData.get("recurringRule"),
    recurrenceRule: formData.get("recurringRule")
  });
}

function validateTaskForm(form, taskData) {
  const requiredFields = ["title", "category", "status", "priority", "dueDate"];
  let isValid = true;

  form.querySelectorAll(".form-field").forEach((field) => {
    field.classList.remove("is-invalid");
  });

  requiredFields.forEach((fieldName) => {
    if (!taskData[fieldName]) {
      const field = form.querySelector(`[data-field="${fieldName}"]`);

      if (field) {
        field.classList.add("is-invalid");
      }

      isValid = false;
    }
  });

  if (requiresDateShiftReason()) {
    const reason = form.elements.dateShiftReason.value.trim();

    if (!reason) {
      const field = form.querySelector('[data-field="dateShiftReason"]');

      if (field) {
        field.classList.add("is-invalid");
      }

      isValid = false;
    }
  }

  return isValid;
}

function requiresDateShiftReason() {
  const dueDateInput = document.querySelector("#task-due-date");

  return Boolean(
    originalModalTask &&
    originalModalTask.isCeoFocus &&
    dueDateInput &&
    dueDateInput.value !== originalModalTask.dueDate
  );
}

function updateCeoDateShiftState() {
  const reasonField = document.querySelector(".ceo-reason-field");
  const reasonInput = document.querySelector("#date-shift-reason");
  const saveButton = document.querySelector("#save-task");

  if (!reasonField || !reasonInput || !saveButton) {
    return;
  }

  const reasonRequired = requiresDateShiftReason();
  reasonField.classList.toggle("is-visible", reasonRequired);
  reasonInput.required = reasonRequired;
  saveButton.disabled = reasonRequired && !reasonInput.value.trim();
}

function handleTaskFormSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const taskData = getFormTaskData(form);

  if (!validateTaskForm(form, taskData)) {
    showToast("заполните обязательные поля", "error");
    return;
  }

  const now = new Date().toISOString();
  const reason = form.elements.dateShiftReason.value.trim();

  if (activeModalTaskId) {
    const taskIndex = appDB.tasks.findIndex((task) => task.id === activeModalTaskId);

    if (taskIndex === -1) {
      showToast("задача не найдена", "error");
      return;
    }

    const beforeTask = appDB.tasks[taskIndex];
    const updatedTask = normalizeTask({
      ...beforeTask,
      ...taskData,
      id: beforeTask.id,
      createdAt: beforeTask.createdAt,
      updatedAt: now,
      completedAt: taskData.status === "done" ? (beforeTask.completedAt || now) : ""
    });
    const changes = getTaskChanges(beforeTask, updatedTask);

    appDB.tasks[taskIndex] = updatedTask;

    if (Object.keys(changes).length) {
      addAuditLog("update", updatedTask.id, changes, "");
    }

    if (beforeTask.status !== updatedTask.status) {
      addAuditLog("status_change", updatedTask.id, {
        status: {
          from: beforeTask.status,
          to: updatedTask.status
        }
      }, "");
    }

    if (beforeTask.isCeoFocus && beforeTask.dueDate !== updatedTask.dueDate) {
      addAuditLog("date_shift", updatedTask.id, {
        dueDate: {
          from: beforeTask.dueDate,
          to: updatedTask.dueDate
        }
      }, reason);
    }
  } else {
    const createdTask = normalizeTask({
      ...taskData,
      createdAt: now,
      updatedAt: now,
      completedAt: taskData.status === "done" ? now : ""
    });

    appDB.tasks.push(createdTask);
    addAuditLog("create", createdTask.id, createdTask, "");
  }

  if (!saveDB(appDB)) {
    return;
  }

  closeTaskModal();
  renderApp();
  showToast("задача сохранена", "success");
}

function deleteTask(taskId) {
  const taskIndex = appDB.tasks.findIndex((task) => task.id === taskId);

  if (taskIndex === -1) {
    return;
  }

  const [removedTask] = appDB.tasks.splice(taskIndex, 1);
  addAuditLog("delete", removedTask.id, removedTask, "");
  if (!saveDB(appDB)) {
    return;
  }

  renderApp();
  showToast("задача удалена", "success");
}

function updateTaskStatusFromKanban(taskId, nextStatus) {
  const taskIndex = appDB.tasks.findIndex((task) => task.id === taskId);

  if (taskIndex === -1 || !KANBAN_COLUMNS.includes(nextStatus)) {
    renderKanbanBoard();
    return;
  }

  const currentTask = appDB.tasks[taskIndex];

  if (currentTask.status === nextStatus || (currentTask.status === "todo" && nextStatus === "backlog")) {
    renderKanbanBoard();
    return;
  }

  const now = new Date().toISOString();
  const updatedTask = normalizeTask({
    ...currentTask,
    status: nextStatus,
    updatedAt: now,
    completedAt: nextStatus === "done" ? (currentTask.completedAt || now) : ""
  });

  appDB.tasks[taskIndex] = updatedTask;
  addAuditLog("status_change", updatedTask.id, {
    status: {
      from: currentTask.status,
      to: nextStatus
    }
  }, "Статус изменен на канбан-доске");
  if (!saveDB(appDB)) {
    return;
  }

  renderApp();
  showToast("статус задачи обновлен", "success");
}

function validateImportedDB(candidate) {
  return Boolean(
    candidate &&
    typeof candidate === "object" &&
    Object.prototype.hasOwnProperty.call(candidate, "version") &&
    Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.auditLog)
  );
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function parseBackupJSON(text) {
  try {
    const parsed = JSON.parse(text);

    if (!validateImportedDB(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function exportDB() {
  const exportDate = new Date().toISOString().slice(0, 10);
  const fileName = `cfo-task-control-center-backup-${exportDate}.json`;
  const blob = new Blob([JSON.stringify(appDB, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("экспорт базы запущен", "success");
}

function mergeAuditLogs(localLog, importedLog) {
  const merged = [];
  const seen = new Set();

  [...localLog, ...importedLog].map(normalizeAuditEntry).forEach((entry) => {
    const key = entry.logId || entry.id;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(entry);
  });

  return merged.slice(-AUDIT_LOG_LIMIT);
}

async function importDB(file) {
  if (!file) {
    return;
  }

  let parsed = null;

  try {
    parsed = parseBackupJSON(await readFileAsText(file));
  } catch (error) {
    parsed = null;
  }

  if (!parsed) {
    showToast("структура файла повреждена. импорт отменен", "error");
    return;
  }

  const importedDB = migrateDB(parsed);
  const previousDBSnapshot = JSON.stringify(appDB);
  const localTasksById = new Map(appDB.tasks.map((task) => [task.id, task]));
  let added = 0;
  let updated = 0;
  let skipped = 0;

  importedDB.tasks.forEach((importedTask) => {
    const localTask = localTasksById.get(importedTask.id);

    if (!localTask) {
      appDB.tasks.push(importedTask);
      added += 1;
      return;
    }

    const localUpdatedAt = Date.parse(localTask.updatedAt || "") || 0;
    const importedUpdatedAt = Date.parse(importedTask.updatedAt || "") || 0;

    if (importedUpdatedAt > localUpdatedAt) {
      const taskIndex = appDB.tasks.findIndex((task) => task.id === importedTask.id);
      appDB.tasks[taskIndex] = importedTask;
      updated += 1;
      return;
    }

    skipped += 1;
  });

  appDB.categories = mergeCategories([...appDB.categories, ...(importedDB.categories || [])]);
  appDB.auditLog = mergeAuditLogs(appDB.auditLog, importedDB.auditLog);
  addAuditLog("import_merge", "", { added, updated, skipped }, "Импорт базы слиянием");

  if (!saveDB(appDB)) {
    appDB = JSON.parse(previousDBSnapshot);
    renderApp();
    return;
  }

  renderApp();
  showToast(`импорт завершен. добавлено: ${added}. обновлено: ${updated}. пропущено: ${skipped}`, "info");
}

function openOverwriteDBModal() {
  const modalRoot = document.querySelector("#modal-root");

  modalRoot.innerHTML = `
    <div class="modal-overlay" data-action="close-overwrite-modal">
      <section class="task-modal" role="dialog" aria-modal="true" aria-labelledby="overwrite-modal-title">
        <div class="modal-header">
          <div>
            <p class="section-code">FULL RESTORE</p>
            <h2 id="overwrite-modal-title">Полная перезапись базы</h2>
          </div>
          <button class="compact-button" type="button" data-action="close-overwrite-modal">Закрыть</button>
        </div>
        <form class="modal-form" id="overwrite-db-form">
          <div class="overwrite-warning">
            Внимание: текущая база в LocalStorage будет полностью заменена выбранным JSON-файлом. Для подтверждения введите строго ПЕРЕЗАПИСАТЬ.
          </div>
          <div class="form-field span-2">
            <label for="overwrite-confirm-text">Контрольное слово</label>
            <input id="overwrite-confirm-text" name="confirmText" autocomplete="off">
          </div>
          <div class="form-field span-2">
            <label for="overwrite-file">Файл бекапа</label>
            <input id="overwrite-file" name="backupFile" type="file" accept="application/json,.json">
          </div>
        </form>
        <div class="modal-footer">
          <button class="compact-button" type="button" data-action="close-overwrite-modal">Отмена</button>
          <button class="danger-button" id="confirm-overwrite-db" type="submit" form="overwrite-db-form" disabled>Перезаписать</button>
        </div>
      </section>
    </div>
  `;

  const form = document.querySelector("#overwrite-db-form");
  const confirmInput = document.querySelector("#overwrite-confirm-text");
  const fileInput = document.querySelector("#overwrite-file");
  const submitButton = document.querySelector("#confirm-overwrite-db");
  const updateSubmitState = () => {
    submitButton.disabled = confirmInput.value !== "ПЕРЕЗАПИСАТЬ" || !fileInput.files.length;
  };

  confirmInput.addEventListener("input", updateSubmitState);
  fileInput.addEventListener("change", updateSubmitState);
  modalRoot.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target.dataset.action === "close-overwrite-modal") {
      modalRoot.innerHTML = "";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (confirmInput.value !== "ПЕРЕЗАПИСАТЬ") {
      showToast("контрольное слово введено неверно", "error");
      return;
    }

    let parsed = null;

    try {
      parsed = parseBackupJSON(await readFileAsText(fileInput.files[0]));
    } catch (error) {
      parsed = null;
    }

    if (!parsed) {
      showToast("структура файла повреждена. импорт отменен", "error");
      return;
    }

    const previousDB = appDB;
    appDB = migrateDB(parsed);
    addAuditLog("overwrite_restore", "", {}, "Полная перезапись базы из JSON-файла");

    if (saveDB(appDB)) {
      modalRoot.innerHTML = "";
      renderApp();
      showToast("база успешно перезаписана", "success");
    } else {
      appDB = previousDB;
      renderApp();
    }
  });
  confirmInput.focus();
}

function handleDemoDataCreation() {
  if (appDB.tasks.length > 0) {
    showToast("демо-данные не созданы: база задач уже содержит записи", "error");
    return;
  }

  appDB.tasks = createDemoTasks();
  addAuditLog("demo-data", "", { count: 10 }, "Создано 10 демонстрационных задач");
  if (!saveDB(appDB)) {
    return;
  }

  renderApp();
  showToast("создано 10 демонстрационных задач", "success");
}

document.addEventListener("DOMContentLoaded", () => {
  appDB = loadDB();

  const tabs = Array.from(document.querySelectorAll(".nav-tab"));
  const screens = Array.from(document.querySelectorAll(".screen"));
  const demoButton = document.querySelector("#create-demo-data");
  const exportButton = document.querySelector("#export-db");
  const importMergeButton = document.querySelector("#import-merge-db");
  const importMergeFile = document.querySelector("#import-merge-file");
  const overwriteButton = document.querySelector("#overwrite-db");
  const createTaskButton = document.querySelector("#create-task");
  const taskTableBody = document.querySelector("#task-table-body");
  const taskToolbar = document.querySelector("#task-toolbar");
  const taskTable = document.querySelector(".task-table");
  const kanbanBoard = document.querySelector("#kanban-board");
  const priorityMatrix = document.querySelector("#priority-matrix");
  const riskMap = document.querySelector("#risk-map");

  const activateScreen = (screenName) => {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.screen === screenName;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });

    screens.forEach((screen) => {
      screen.classList.toggle("is-active", screen.dataset.screen === screenName);
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateScreen(tab.dataset.screen);
    });
  });

  if (demoButton) {
    demoButton.addEventListener("click", handleDemoDataCreation);
  }

  if (exportButton) {
    exportButton.addEventListener("click", exportDB);
  }

  if (importMergeButton && importMergeFile) {
    importMergeButton.addEventListener("click", () => {
      importMergeFile.value = "";
      importMergeFile.click();
    });
    importMergeFile.addEventListener("change", () => {
      importDB(importMergeFile.files[0]);
    });
  }

  if (overwriteButton) {
    overwriteButton.addEventListener("click", openOverwriteDBModal);
  }

  if (createTaskButton) {
    createTaskButton.addEventListener("click", () => openTaskModal());
  }

  if (taskTableBody) {
    taskTableBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-task-id]");

      if (!row) {
        return;
      }

      openTaskModal(row.dataset.taskId);
    });
  }

  if (taskToolbar) {
    taskToolbar.addEventListener("input", (event) => {
      if (event.target.id === "task-search") {
        taskListState.search = event.target.value;
        renderTaskTable();
      }
    });

    taskToolbar.addEventListener("change", (event) => {
      const filterName = event.target.dataset.filter;
      const quickFilterName = event.target.dataset.quickFilter;

      if (filterName) {
        taskListState.filters[filterName] = event.target.value;
        renderTaskTable();
      }

      if (quickFilterName) {
        taskListState.quickFilters[quickFilterName] = event.target.checked;
        renderTaskTable();
      }
    });

    taskToolbar.addEventListener("click", (event) => {
      if (event.target.id !== "reset-task-filters") {
        return;
      }

      taskListState.search = "";
      taskListState.filters = {
        status: "",
        category: "",
        priority: "",
        taskType: "",
        riskLevel: ""
      };
      taskListState.quickFilters = {
        overdueOnly: false,
        todayOnly: false,
        ceoOnly: false,
        delegatedOnly: false,
        hideDone: true
      };
      taskListState.sort = {
        field: "",
        direction: "asc"
      };
      renderApp();
    });
  }

  if (taskTable) {
    taskTable.addEventListener("click", (event) => {
      const sortButton = event.target.closest("[data-sort-field]");

      if (!sortButton) {
        return;
      }

      const field = sortButton.dataset.sortField;

      if (taskListState.sort.field === field) {
        taskListState.sort.direction = taskListState.sort.direction === "asc" ? "desc" : "asc";
      } else {
        taskListState.sort.field = field;
        taskListState.sort.direction = "asc";
      }

      renderTaskTable();
    });
  }

  if (kanbanBoard) {
    kanbanBoard.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".kanban-card");

      if (!card) {
        return;
      }

      event.dataTransfer.setData("text/plain", card.dataset.taskId);
      event.dataTransfer.effectAllowed = "move";
    });

    kanbanBoard.addEventListener("dragover", (event) => {
      const dropzone = event.target.closest(".kanban-dropzone");

      if (!dropzone) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      dropzone.classList.add("is-drag-over");
    });

    kanbanBoard.addEventListener("dragleave", (event) => {
      const dropzone = event.target.closest(".kanban-dropzone");

      if (!dropzone || dropzone.contains(event.relatedTarget)) {
        return;
      }

      dropzone.classList.remove("is-drag-over");
    });

    kanbanBoard.addEventListener("drop", (event) => {
      const dropzone = event.target.closest(".kanban-dropzone");

      if (!dropzone) {
        renderKanbanBoard();
        return;
      }

      event.preventDefault();
      dropzone.classList.remove("is-drag-over");
      updateTaskStatusFromKanban(event.dataTransfer.getData("text/plain"), dropzone.dataset.dropStatus);
    });

    kanbanBoard.addEventListener("click", (event) => {
      const card = event.target.closest(".kanban-card");

      if (card) {
        openTaskModal(card.dataset.taskId);
      }
    });

    kanbanBoard.addEventListener("dblclick", (event) => {
      const card = event.target.closest(".kanban-card");

      if (card) {
        openTaskModal(card.dataset.taskId);
      }
    });
  }

  [priorityMatrix, riskMap].forEach((analyticsRoot) => {
    if (!analyticsRoot) {
      return;
    }

    analyticsRoot.addEventListener("click", (event) => {
      const card = event.target.closest(".analytics-card");

      if (card) {
        openTaskModal(card.dataset.taskId);
      }
    });

    analyticsRoot.addEventListener("keydown", (event) => {
      const card = event.target.closest(".analytics-card");

      if (card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openTaskModal(card.dataset.taskId);
      }
    });
  });

  renderApp();
});
