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

export interface ContentSignal {
  agent: AgentName;
  pattern: RegExp;
  description: string;
}

export const CONTENT_SIGNALS: ContentSignal[] = [
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
  { agent: 'senior-qa', pattern: /\b(describe|it|test)\s*\(/, description: 'JS/TS test' },
  { agent: 'senior-qa', pattern: /Assert\.|Should\(\)|expect\s*\(/, description: 'Assertion' },

  { agent: 'senior-developer', pattern: /HttpClient|IHttpClientFactory/, description: 'HTTP client (external integration)' },
  { agent: 'senior-developer', pattern: /Polly|RetryPolicy|CircuitBreaker/, description: 'Resilience policy' },
  { agent: 'senior-developer', pattern: /ILogger<|Activity\.Current|MetricsCollector/, description: 'Observability' },
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
  { agent: 'senior-dev-security', pattern: /Controller\.cs$/i, description: 'Controller naming' },
  { agent: 'senior-dev-security', pattern: /[\\/]Endpoints?[\\/]/i, description: 'endpoints folder' },
  { agent: 'senior-dev-security', pattern: /(Auth|Identity|Jwt)\w*\.cs$/i, description: 'auth file naming' },
  { agent: 'senior-architect', pattern: /Program\.cs$|Startup\.cs$/i, description: 'composition root' },
  { agent: 'senior-architect', pattern: /\.csproj$|Directory\.Packages\.props$/i, description: 'project boundary' },
  { agent: 'senior-architect', pattern: /DependencyInjection\.cs$|ServiceCollectionExtensions\.cs$/i, description: 'DI extensions' },
  { agent: 'senior-qa', pattern: /[\\/]Tests?[\\/]/i, description: 'tests folder' },
  { agent: 'senior-qa', pattern: /\.(test|spec|tests)\.(ts|js|cs)$/i, description: 'test file naming' },
];
