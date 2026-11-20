export type Profile = "small" | "tiny";
export const PROFILES: Record<Profile, { cpus: number; mem: string }> = {
  small: { cpus: 1, mem: "1g" },
  tiny: { cpus: 0.5, mem: "512m" },
};
// same limits as PROFILES.mem, in MiB (kept separate: tests pin the PROFILES shape)
export const MEM_MB: Record<Profile, number> = { small: 1024, tiny: 512 };

// compose interpolates ${VAR} from the host env: escape $ in anything that comes from the project
const esc = (s: string) => s.replaceAll("$", "$$$$");

export function composeFile(o: { runId: string; profile: Profile; dbPassword: string; envFile: string; mockDir: string;
  app: { context: string; dockerfile: string; buildCmd?: string; command?: string[]; healthPath: string } }): object {
  const labels = { "vibe-breakpoint": "1", "vibe-breakpoint.run": o.runId };
  const { cpus, mem } = PROFILES[o.profile];
  const base = { labels, networks: ["vb-net"] };
  const node = { image: "node:22-alpine", init: true };
  return {
    name: o.runId,
    networks: { "vb-net": { internal: true, labels } },
    services: {
      db: {
        ...base,
        image: "postgres:16",
        command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=all"],
        environment: { POSTGRES_USER: "vb", POSTGRES_PASSWORD: o.dbPassword, POSTGRES_DB: "vb" },
        tmpfs: ["/var/lib/postgresql/data"],
        cpus,
        mem_limit: mem,
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U vb -d vb"], interval: "1s", timeout: "3s", retries: 60 },
      },
      mock: {
        ...base,
        ...node,
        command: ["node", "/mock/server.mjs"],
        volumes: [`${o.mockDir}:/mock:ro`],
        healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:4010/__vb/health"], interval: "1s", timeout: "3s", retries: 30 },
        environment: { MOCK_LATENCY_MS: "0" },
        mem_limit: "256m",
      },
      app: {
        ...base,
        init: true,
        image: "vb-app:" + o.runId,
        build: { context: o.app.context, dockerfile: o.app.dockerfile, labels, ...(o.app.buildCmd && { args: { BUILD_CMD: o.app.buildCmd } }) },
        ...(o.app.command && { command: o.app.command.map(esc) }),
        env_file: [o.envFile],
        cpus,
        mem_limit: mem,
        depends_on: { db: { condition: "service_healthy" }, mock: { condition: "service_healthy" } },
        healthcheck: {
          test: ["CMD", "node", "-e", `fetch("http://127.0.0.1:3000"+${esc(JSON.stringify(o.app.healthPath))}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`],
          // ponytail: probes only during boot so no healthcheck request lands in the probe/load windows (D-041); runs longer than 24 h get one probe per 24 h; needs Engine 25+ (start_interval); upgrade path: CLI-side readiness polling
          interval: "24h", start_period: "120s", start_interval: "1s", timeout: "5s",
        },
      },
      k6: { ...base, image: "grafana/k6", profiles: ["load"], environment: { K6_NO_USAGE_REPORT: "true" } },
    },
  };
}
