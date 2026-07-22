// Demo 8 launcher — starts the REAL kcp-memory daemon handlers over REAL HTTP on
// an isolated, ephemeral port with an isolated temp DB.
//
// Why a launcher instead of `kcp-memory daemon`? The shipped CLI hard-binds port
// 7735 (KcpMemoryDaemon.PORT), which on a developer box is already held by the
// user's own kcp-memory daemon and points at the real ~/.kcp/memory.db. This
// launcher wires the SAME published handlers (HealthHandler, SearchHandler,
// GovernanceHandler, IngestHandler, ListHandler) — the real recall gate and
// governance store — onto a free port over an isolated DB, so the demo never
// touches the user's daemon or data. Only the bootstrap port/DB differ; every
// governance decision is the real daemon's code.
//
// Seeding uses the real SessionStore.upsert() — the exact call the scanner makes
// — so seeded memories carry auto-derived provenance, just like a scanned
// session. The recall gate itself is then exercised entirely over HTTP.

import com.cantara.kcp.memory.store.MemoryDatabase;
import com.cantara.kcp.memory.store.SessionStore;
import com.cantara.kcp.memory.model.Session;
import com.cantara.kcp.memory.server.TcpHttpServer;
import com.cantara.kcp.memory.handler.HealthHandler;
import com.cantara.kcp.memory.handler.SearchHandler;
import com.cantara.kcp.memory.handler.ListHandler;
import com.cantara.kcp.memory.handler.GovernanceHandler;
import com.cantara.kcp.memory.handler.IngestHandler;

import java.nio.file.Path;
import java.time.Instant;

public class MemoryGovDemoServer {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        Path dbPath = Path.of(args[1]);

        MemoryDatabase db = new MemoryDatabase(dbPath); // runs migrations incl. V8 governance
        SessionStore store = new SessionStore(db);
        String now = Instant.now().toString();

        // Three governed memories, all matching the query "authentication".
        store.upsert(seed("sess-live", "/src/acme/auth", "acme-auth",
                "Implement OAuth2 PKCE login for the authentication service",
                "Implement OAuth2 PKCE login for the authentication service with rotating refresh tokens", now));
        store.upsert(seed("sess-expired", "/src/acme/auth", "acme-auth",
                "Draft the authentication service Q2 rollout timeline",
                "Draft the authentication service Q2 rollout timeline and cutover milestones", now));
        store.upsert(seed("sess-forgotten", "/src/acme/auth", "acme-auth",
                "Record the authentication service break-glass admin credentials",
                "Record the authentication service break-glass admin credentials and rotation steps", now));

        TcpHttpServer server = new TcpHttpServer(port);
        server.createContext("/health",     new HealthHandler(db));
        server.createContext("/search",     new SearchHandler(db));
        server.createContext("/sessions",   new ListHandler(db));
        server.createContext("/governance", new GovernanceHandler(db));
        server.createContext("/ingest",     new IngestHandler(db));
        server.start();

        System.out.println("READY " + port);
        System.out.flush();
        Thread.currentThread().join();
    }

    static Session seed(String id, String proj, String slug, String first, String all, String now) {
        Session s = new Session();
        s.setSessionId(id);
        s.setProjectDir(proj);
        s.setSlug(slug);
        s.setFirstMessage(first);
        s.setAllUserText(all);
        s.setStartedAt(now);
        s.setScannedAt(now);
        return s;
    }
}
