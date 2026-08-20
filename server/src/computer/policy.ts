/**
 * Whether a Bot may take one particular action on one particular page.
 *
 * A FORMA veio do policy engine do chassis openbot (deny/allow em expressões,
 * `dry-run` vs `enforce`, default-deny, avaliação fail-closed — e a lista
 * `deny`, que o original não tinha). O MOTOR, desde a Onda 3, é o NOSSO:
 * `evaluateRule` do @aibot2/plugin-action-gateway — o mesmo pacote que carrega
 * o Gate de permissões portado do gateway Go. cel-js saiu do lockfile (§4.5):
 * dois motores de política é o cenário I4 (duas verdades), e o último degrau
 * antes do efeito não roda parser de terceiro que ninguém daqui audita.
 *
 * Expressão em vez de tabela de colunas, ainda assim: o limite que uma empresa
 * quer é uma frase ("nunca clique em nada que diga Submit fora do nosso
 * domínio"), e uma tabela só expressa as formas que nós antecipamos. O
 * subconjunto aceito (==, !=, &&, ||, !, contains, matches, caminhos) está
 * declarado no motor — regra fora dele FALHA ALTO, nunca é "entendida" como
 * outra coisa (a memória da casa: política declarada é LIDA).
 *
 * Precedence: deny beats allow. A rule that removes permission must never be
 * defeated by a broader rule that grants it, or a company cannot reason about what it has forbidden.
 */
import { evaluateRule } from "@aibot2/plugin-action-gateway";

export type PolicyMode = "dry-run" | "enforce";

export type ActionPolicy = {
  /**
   * `enforce` blocks. `dry-run` decides and records, and lets everything through.
   *
   * Dry-run exists so an operator can write a rule against real traffic and read the audit trail
   * before it starts refusing anybody's work. A governance feature nobody dares switch on is not a
   * governance feature.
   */
  mode: PolicyMode;
  /** Evaluated first. Any expression true means refused, whatever `allow` says. */
  deny: string[];
  /** Any expression true means permitted. Empty means nothing is permitted. */
  allow: string[];
};

/**
 * The attributes a rule can be written against.
 *
 * `element` is resolved by the gateway from the snapshot the server itself fetched, never from what
 * the caller claimed it was clicking. A policy that decides on an attacker-supplied label is
 * decoration: the whole point is that "do not click Submit" cannot be evaded by calling it something
 * else in the request.
 */
export type PolicyContext = {
  tool: { name: string };
  bot: { id: string };
  page: { url: string; host: string };
  actor: { id: string };
  element?: {
    ref: string;
    role: string;
    name: string;
    type?: string;
  };
  /**
   * The key a `computer_key` call is about to press.
   *
   * Without this, a rule about clicking is bypassed. An agent that meets a deny rule on
   * clicking "Submit order" will press Enter in the form instead, and the order goes through: the
   * click is refused and audited, the keypress is allowed, because nothing in the context could tell
   * one keypress from another.
   *
   * A form has two doors and the policy could only see one. Now a rule can say
   * `tool.name == "computer_key" && key == "Enter"`, and an operator blocking a submit button knows
   * to block both routes, which the deny example in `.env.example` now does.
   */
  key?: string;
  /**
   * What the action does, rather than which tool was called.
   *
   * `tool.name` describes mechanism. An operator thinks in effects, "do not activate anything called
   * submit", and mechanism is a poor proxy for effect: a button is activated by a click OR by Enter
   * OR by Space, so a rule naming `computer_click` covers only one activation path.
   *
   * `activate`, a click, or Enter or Space, which are the gestures that press a thing.
   * `type`, text going into a field, including any other keypress.
   * `navigate`, opening a page.
   * `read`, looking at the page or listing what is on it.
   * `write_file` / `read_file` / `list_files`, the workspace.
   *
   * It still cannot see whether a keypress will submit a form. A browser submits
   * from Enter in any field of it, and the element a keypress names is the field, not the form. The
   * gateway would need to know the page's structure at decision time, which it does not, refs are
   * held off-DOM by Playwright and the policy runs before the action reaches the browser. So a rule
   * that must stop a submission still has to refuse Enter outright, and the preset says so.
   */
  intent?:
    | "activate"
    | "type"
    | "navigate"
    | "read"
    | "read_file"
    | "write_file"
    | "list_files"
    // A tool on somebody else's MCP server. Split by effect for the same reason as the browser
    // intents: an operator thinks "nothing may change anything in Jira", not "nothing may call
    // editJiraIssue, transitionJiraIssue, addCommentToJiraIssue and the six others".
    | "read_tool"
    | "write_tool";
  /**
   * The file a `computer_read_file` or `computer_write_file` call is aimed at.
   *
   * The path is as the Bot asked for it, relative to its workspace. Containment is not policy: a path
   * that tries to escape is refused by the computer itself and is not negotiable. A rule here is about
   * which files inside the workspace a given Bot may touch.
   *
   * `name` and `extension` are split out because the rules people actually want are "nothing called
   * *.env" and "nothing under credentials/", and making them write string surgery in CEL to express
   * that would guarantee subtly wrong rules.
   */
  file?: {
    path: string;
    name: string;
    /** Without the dot, and lower-case. Empty for a file with no extension. */
    extension: string;
  };
  /**
   * The MCP server and tool a call is aimed at.
   *
   * Split out rather than left in `tool.name`. The offered tool name is `mcp__jira__editJiraIssue`,
   * and asking an operator to write string surgery against that to say "nothing may write to Jira"
   * would guarantee rules that are subtly wrong the first time a vendor renames something. Server,
   * tool and effect are three plain fields instead.
   *
   * `effect` is decided by the server's own advertised catalogue crossed with a reviewed list of
   * which of its tools change things, and it fails closed: anything not positively known to be a
   * read is a write.
   */
  mcp?: {
    server: string;
    tool: string;
    effect: "read" | "write";
  };
};

export type PolicyDecision = {
  allowed: boolean;
  mode: PolicyMode;
  /** Which expression decided it, so the audit row can say why and an operator can find the rule. */
  matched: string | null;
  /** Which list that expression came from. `default` means nothing matched and the floor applied. */
  source: "deny" | "allow" | "default";
  /** True when the action should actually be carried out. False for a refusal in `enforce`. */
  forward: boolean;
  /** Why, in words that go in front of a person. */
  reason: string;
};

/**
 * Evaluate one expression. Never throws.
 *
 * `contains` e `matches` são embutidos do motor (caso-insensíveis por
 * contrato — a regra "nunca clique em submit" pega o botão "SUBMIT").
 *
 * `onError` decides what a broken expression means, because the safe answer differs by list: a broken
 * `allow` must not permit, and a broken `deny` must not stop denying. Both are logged loudly, because
 * a policy that silently misbehaves is worse than one that visibly refuses.
 */
function matches(
  expression: string,
  context: PolicyContext,
  onError: boolean,
): boolean {
  try {
    return (
      evaluateRule(expression, context as unknown as Record<string, unknown>) ===
      true
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "computer-policy-expression-error",
        expression,
        error: String(error),
        treatedAs: onError,
      }),
    );
    return onError;
  }
}

/**
 * Decide whether this action may run.
 *
 * An absent policy denies. An unconfigured deployment is one that has not said what its Bots may do,
 * and the safe reading of silence is "nothing", not "anything". The shipped configuration therefore
 * states its permissions explicitly rather than relying on a default, so that what a Bot may do is
 * always something somebody wrote down.
 */
export function evaluateActionPolicy(
  policy: ActionPolicy | null | undefined,
  context: PolicyContext,
): PolicyDecision {
  const mode: PolicyMode = policy?.mode ?? "enforce";
  const deny = policy?.deny ?? [];
  const allow = policy?.allow ?? [];

  // Deny first, and a broken deny expression still denies. One typo in a rule therefore blocks the
  // action rather than admitting it: the failure is loud, immediate and safe, and the alternative is
  // a deployment that believes it has forbidden something it has not.
  for (const expression of deny) {
    if (matches(expression, context, true)) {
      return {
        allowed: false,
        mode,
        matched: expression,
        source: "deny",
        // dry-run records the refusal and lets the work continue, which is what makes it safe to
        // switch on against live traffic.
        forward: mode === "dry-run",
        reason: describeRefusal(context, expression),
      };
    }
  }

  for (const expression of allow) {
    if (matches(expression, context, false)) {
      return {
        allowed: true,
        mode,
        matched: expression,
        source: "allow",
        forward: true,
        reason: "Permitted by policy.",
      };
    }
  }

  return {
    allowed: false,
    mode,
    matched: null,
    source: "default",
    forward: mode === "dry-run",
    reason:
      "No rule in this deployment's policy permits that action, so it was refused. " +
      "An administrator can add one.",
  };
}

/** A refusal a person can act on: what was refused, and on what. */
function describeRefusal(context: PolicyContext, expression: string): string {
  // A file refusal must not be phrased as happening "on <host>": the workspace has nothing to do with
  // whatever page the browser happens to be showing, and saying so sends somebody to the wrong place.
  if (context.file) {
    return (
      `This deployment's policy does not allow that: the file ${context.file.path} ` +
      `is blocked by the rule \`${expression}\`.`
    );
  }
  const what = context.element?.name
    ? `“${context.element.name}”`
    : `a ${context.tool.name.replace("computer_", "")} action`;
  return (
    `This deployment's policy does not allow that: ${what} on ${context.page.host} ` +
    `is blocked by the rule \`${expression}\`.`
  );
}
