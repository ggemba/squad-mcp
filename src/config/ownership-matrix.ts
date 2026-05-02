export type AgentName =
  | 'po'
  | 'tech-lead-planner'
  | 'tech-lead-consolidator'
  | 'senior-architect'
  | 'senior-dba'
  | 'senior-developer'
  | 'senior-dev-reviewer'
  | 'senior-dev-security'
  | 'senior-qa';

export const AGENT_NAMES: AgentName[] = [
  'po',
  'tech-lead-planner',
  'tech-lead-consolidator',
  'senior-architect',
  'senior-dba',
  'senior-developer',
  'senior-dev-reviewer',
  'senior-dev-security',
  'senior-qa',
];

export const AGENT_NAMES_TUPLE = AGENT_NAMES as [AgentName, ...AgentName[]];

export type WorkType =
  | 'Feature'
  | 'Bug Fix'
  | 'Refactor'
  | 'Performance'
  | 'Security'
  | 'Business Rule';

export interface AgentDef {
  name: AgentName;
  role: string;
  owns: string[];
  conventions: string[];
}

export const AGENTS: Record<AgentName, AgentDef> = {
  po: {
    name: 'po',
    role: 'Business value, UX, requirements fit',
    owns: ['Business value and requirements', 'User experience'],
    conventions: [],
  },
  'tech-lead-planner': {
    name: 'tech-lead-planner',
    role: 'Pre-implementation trade-offs and viability',
    owns: ['Plan viability and trade-off framing (pre-impl)'],
    conventions: [],
  },
  'tech-lead-consolidator': {
    name: 'tech-lead-consolidator',
    role: 'Post-implementation final verdict',
    owns: ['Final merge verdict', 'Design trade-offs', 'CI/CD and deploy', 'Technical debt'],
    conventions: [],
  },
  'senior-architect': {
    name: 'senior-architect',
    role: 'Boundaries, DI, scalability',
    owns: ['Module and domain boundaries', 'Coupling', 'DI registrations and lifetimes', 'Architectural scalability'],
    conventions: [
      '*ServiceCollectionExtensions.cs',
      'Program.cs',
      'Startup.cs',
      '*.csproj',
      'Directory.Packages.props',
    ],
  },
  'senior-dba': {
    name: 'senior-dba',
    role: 'Queries, migrations, EF, cache',
    owns: ['Queries and database performance', 'Migrations and schema', 'EF mappings', 'Data cache', 'Database concurrency'],
    conventions: [
      '*Repository.cs',
      '*Configuration.cs (EF entity config)',
      'Migrations/* (default `dotnet ef migrations` naming)',
    ],
  },
  'senior-developer': {
    name: 'senior-developer',
    role: 'Correctness, robustness, APIs, observability',
    owns: ['Technical correctness', 'Robustness', 'API contracts', 'External integrations', 'Observability', 'App performance'],
    conventions: [],
  },
  'senior-dev-reviewer': {
    name: 'senior-dev-reviewer',
    role: 'Readability, idioms, naming',
    owns: ['Readability and code smells', 'C#/.NET best practices', 'Naming conventions'],
    conventions: [],
  },
  'senior-dev-security': {
    name: 'senior-dev-security',
    role: 'OWASP, authz, sensitive data',
    owns: ['OWASP Top 10', 'Authentication and authorization', 'Sensitive data protection'],
    conventions: ['*Controller.cs (with [ApiController])', 'Auth*.cs'],
  },
  'senior-qa': {
    name: 'senior-qa',
    role: 'Test coverage, strategy, reliability',
    owns: ['Test quality and coverage', 'Test strategy'],
    conventions: ['*Tests.cs', '*Test.cs', '*/Tests/*'],
  },
};

export const SQUAD_BY_TYPE: Record<WorkType, { core: AgentName[]; conditional: { agent: AgentName; when: string }[] }> = {
  Feature: {
    core: ['po', 'senior-developer', 'senior-qa'],
    conditional: [
      { agent: 'senior-dba', when: 'data touched' },
      { agent: 'senior-architect', when: 'new module' },
      { agent: 'senior-dev-security', when: 'endpoint touched' },
    ],
  },
  'Bug Fix': {
    core: ['senior-developer', 'senior-qa'],
    conditional: [
      { agent: 'senior-dba', when: 'query/cache' },
      { agent: 'senior-dev-security', when: 'security bug' },
    ],
  },
  Refactor: {
    core: ['senior-architect', 'senior-dev-reviewer', 'senior-qa'],
    conditional: [{ agent: 'senior-developer', when: 'behavior changes' }],
  },
  Performance: {
    core: ['senior-developer', 'senior-dba'],
    conditional: [{ agent: 'senior-architect', when: 'structural' }],
  },
  Security: {
    core: ['senior-dev-security', 'senior-developer'],
    conditional: [{ agent: 'senior-dev-reviewer', when: 'large code change' }],
  },
  'Business Rule': {
    core: ['po', 'senior-developer', 'senior-qa'],
    conditional: [{ agent: 'senior-dba', when: 'data-bound' }],
  },
};

/**
 * Detection signal contract: signals are ADDITIVE only.
 *
 * Worst case from a bad signal = an extra agent is selected (cost, never wrong exclusion).
 * Never remove or override a signal as part of a tightening effort — the matrix grows;
 * it does not arbitrate.
 *
 * `ext_filter`, when provided, is a list of lowercase file extensions (including dot)
 * that gate the signal. Use it for cross-stack patterns that would false-positive in
 * unrelated languages (e.g. `Schema(` in JS vs Python). Match: case-insensitive
 * `path.extname(file)`.
 */
export interface ContentSignal {
  agent: AgentName;
  pattern: RegExp;
  description: string;
  ext_filter?: string[];
}

const TS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const TSX_EXT = ['.ts', '.tsx', '.jsx'];
const PY_EXT = ['.py'];
const GO_EXT = ['.go'];

export const CONTENT_SIGNALS: ContentSignal[] = [
  // .NET / C# (existing)
  { agent: 'senior-dba', pattern: /class\s+\w+\s*:\s*DbContext/, description: 'EF DbContext' },
  { agent: 'senior-dba', pattern: /:\s*IRepository</, description: 'Repository pattern' },
  { agent: 'senior-dba', pattern: /modelBuilder\.Entity</, description: 'EF model config' },
  { agent: 'senior-dba', pattern: /\b(HasMany|HasOne|HasIndex|HasKey|HasForeignKey)\s*\(/, description: 'EF relationship' },
  { agent: 'senior-dba', pattern: /\[Table\(/, description: 'EF Table attribute' },
  { agent: 'senior-dba', pattern: /\b(CREATE|ALTER|DROP)\s+TABLE\b/i, description: 'DDL' },
  { agent: 'senior-dba', pattern: /AddDbContext|UseSqlServer|UseNpgsql|UseSqlite|UseMySql/, description: 'EF provider registration' },
  { agent: 'senior-dba', pattern: /\bSELECT\b[\s\S]{0,200}\bFROM\b/i, description: 'Raw SQL query' },
  { agent: 'senior-dba', pattern: /\b(IDbConnection|SqlConnection|NpgsqlConnection)\b/, description: 'ADO.NET connection' },
  { agent: 'senior-dba', pattern: /Migration|migrationBuilder\./, description: 'EF migration' },

  { agent: 'senior-dev-security', pattern: /\[Authorize/, description: 'Authorize attribute' },
  { agent: 'senior-dev-security', pattern: /\[ApiController\]/, description: 'API controller' },
  { agent: 'senior-dev-security', pattern: /\[Http(Get|Post|Put|Delete|Patch)/, description: 'HTTP endpoint' },
  { agent: 'senior-dev-security', pattern: /\b(JwtBearer|OAuth|SignInManager|UserManager|IdentityUser)\b/, description: 'Auth surface' },
  { agent: 'senior-dev-security', pattern: /UseAuthentication|UseAuthorization/, description: 'Auth middleware' },
  { agent: 'senior-dev-security', pattern: /\b(BCrypt|PasswordHasher|HMACSHA|Rfc2898DeriveBytes)\b/, description: 'Crypto/password handling' },

  { agent: 'senior-architect', pattern: /services\.Add(Scoped|Transient|Singleton)\s*</, description: 'DI registration' },
  { agent: 'senior-architect', pattern: /WebApplication\.CreateBuilder/, description: 'Composition root' },
  { agent: 'senior-architect', pattern: /AddMediatR|AddAutoMapper|AddFluentValidation/, description: 'Cross-cutting registration' },
  { agent: 'senior-architect', pattern: /<Project\s+Sdk=/, description: 'csproj' },

  { agent: 'senior-qa', pattern: /\[Fact\]|\[Theory\]/, description: 'xUnit test' },
  { agent: 'senior-qa', pattern: /\[Test\]|\[TestCase\]/, description: 'NUnit test' },
  { agent: 'senior-qa', pattern: /\b(describe|it|test)\s*\(/, description: 'JS/TS test', ext_filter: TS_EXT },
  { agent: 'senior-qa', pattern: /Assert\.|Should\(\)|expect\s*\(/, description: 'Assertion' },

  { agent: 'senior-developer', pattern: /HttpClient|IHttpClientFactory/, description: 'HTTP client (.NET integration)' },
  { agent: 'senior-developer', pattern: /Polly|RetryPolicy|CircuitBreaker/, description: 'Resilience policy' },
  { agent: 'senior-developer', pattern: /ILogger<|Activity\.Current|MetricsCollector/, description: 'Observability' },

  // TypeScript / Node
  { agent: 'senior-developer', pattern: /from\s+['"]express['"]/, description: 'Express import', ext_filter: TS_EXT },
  { agent: 'senior-dev-security', pattern: /\bRouter\s*\(\s*\)/, description: 'Express router', ext_filter: TS_EXT },
  { agent: 'senior-dba', pattern: /\bprisma\.\w+\.(findFirst|findMany|findUnique|create|update|delete|upsert)\b/, description: 'Prisma client query', ext_filter: TS_EXT },
  { agent: 'senior-dba', pattern: /from\s+['"]typeorm['"]|@Entity\s*\(/, description: 'TypeORM', ext_filter: TS_EXT },
  { agent: 'senior-dba', pattern: /from\s+['"]sequelize['"]|sequelize\.define\s*\(/, description: 'Sequelize', ext_filter: TS_EXT },
  { agent: 'senior-dba', pattern: /from\s+['"]mongoose['"]|mongoose\.Schema\s*\(/, description: 'Mongoose', ext_filter: TS_EXT },
  { agent: 'senior-dev-security', pattern: /from\s+['"]bcrypt(?:js)?['"]/, description: 'bcrypt import', ext_filter: TS_EXT },
  { agent: 'senior-dev-security', pattern: /\bpassport\.(use|authenticate)\s*\(/, description: 'Passport auth', ext_filter: TS_EXT },
  { agent: 'senior-dev-security', pattern: /from\s+['"]jsonwebtoken['"]|\bjwt\.(sign|verify)\s*\(/, description: 'JWT', ext_filter: TS_EXT },
  { agent: 'senior-developer', pattern: /\buseState\s*\(|\buseEffect\s*\(/, description: 'React hook', ext_filter: TSX_EXT },
  { agent: 'senior-developer', pattern: /from\s+['"]next\//, description: 'Next.js', ext_filter: TS_EXT },

  // Python
  { agent: 'senior-dba', pattern: /from\s+sqlalchemy/, description: 'SQLAlchemy', ext_filter: PY_EXT },
  { agent: 'senior-developer', pattern: /from\s+(django|flask|fastapi)\b/, description: 'Python web framework', ext_filter: PY_EXT },
  { agent: 'senior-dev-security', pattern: /@app\.route|@router\.(get|post|put|delete|patch)/, description: 'Python HTTP route', ext_filter: PY_EXT },
  { agent: 'senior-dba', pattern: /import\s+alembic|alembic\.config/, description: 'Alembic migration', ext_filter: PY_EXT },
  { agent: 'senior-qa', pattern: /import\s+pytest|^def\s+test_/m, description: 'pytest', ext_filter: PY_EXT },
  { agent: 'senior-qa', pattern: /import\s+unittest/, description: 'unittest', ext_filter: PY_EXT },

  // Go
  { agent: 'senior-dba', pattern: /\bgorm\.(Open|Model|DB)\b/, description: 'GORM', ext_filter: GO_EXT },
  { agent: 'senior-dba', pattern: /\bsqlx\.(Open|Connect|MustConnect)\b/, description: 'sqlx', ext_filter: GO_EXT },
  { agent: 'senior-dev-security', pattern: /\bgin\.(Default|New)\b|\bchi\.(Mux|NewRouter)\b|\becho\.New\b/, description: 'Go HTTP framework', ext_filter: GO_EXT },
];

export interface PathHint {
  agent: AgentName;
  pattern: RegExp;
  description: string;
}

export const PATH_HINTS: PathHint[] = [
  { agent: 'senior-dba', pattern: /[\\/]Migrations[\\/]/i, description: 'migrations folder' },
  { agent: 'senior-dba', pattern: /\.(sql|psql)$/i, description: 'SQL file' },
  { agent: 'senior-dba', pattern: /Repository\.cs$/i, description: 'Repository naming' },
  { agent: 'senior-dba', pattern: /DbContext\.cs$/i, description: 'DbContext naming' },
  { agent: 'senior-dba', pattern: /[\\/]models[\\/]/i, description: 'models folder' },
  { agent: 'senior-dev-security', pattern: /Controller\.cs$/i, description: 'Controller naming' },
  { agent: 'senior-dev-security', pattern: /[\\/]Endpoints?[\\/]/i, description: 'endpoints folder' },
  { agent: 'senior-dev-security', pattern: /(Auth|Identity|Jwt)\w*\.cs$/i, description: 'auth file naming' },
  { agent: 'senior-developer', pattern: /[\\/](api|handlers|middleware|services)[\\/]/i, description: 'api/handlers/middleware/services folder' },
  { agent: 'senior-architect', pattern: /Program\.cs$|Startup\.cs$/i, description: 'composition root' },
  { agent: 'senior-architect', pattern: /\.csproj$|Directory\.Packages\.props$/i, description: 'project boundary' },
  { agent: 'senior-architect', pattern: /DependencyInjection\.cs$|ServiceCollectionExtensions\.cs$/i, description: 'DI extensions' },
  { agent: 'senior-qa', pattern: /[\\/]Tests?[\\/]/i, description: 'tests folder' },
  { agent: 'senior-qa', pattern: /\.(test|spec|tests)\.(ts|tsx|js|jsx|cs)$/i, description: 'test file naming' },
  { agent: 'senior-qa', pattern: /_test\.go$/i, description: 'Go test file naming' },
  { agent: 'senior-qa', pattern: /(?:^|[\\/])test_[\w-]+\.py$/i, description: 'Python pytest naming' },
];

/**
 * Returns true when the signal applies to the given file path.
 * If `ext_filter` is unset, the signal applies to all files (default behavior).
 */
export function signalApplies(sig: ContentSignal, file: string): boolean {
  if (!sig.ext_filter || sig.ext_filter.length === 0) return true;
  const ext = file.toLowerCase().match(/\.[^./\\]+$/)?.[0];
  return ext !== undefined && sig.ext_filter.includes(ext);
}
