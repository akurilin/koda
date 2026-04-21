import type {
  BlockNoteBlock,
  InlineContent,
  SupportedBlockType,
} from "@/src/server/documents/types";

type DemoEntry =
  | { kind: "heading"; level: 1 | 2 | 3; content: InlineContent[] }
  | { kind: "paragraph"; content: InlineContent[] }
  | { kind: "quote"; content: InlineContent[] };

const demoEntries: DemoEntry[] = [
  {
    kind: "heading",
    level: 1,
    content: [{ type: "text", text: "The Code Nobody Reads", styles: {} }],
  },
  {
    kind: "quote",
    content: [
      {
        type: "text",
        text: "Civilization advances by extending the number of important operations which we can perform without thinking of them.",
        styles: {},
      },
    ],
  },
  {
    kind: "quote",
    content: [{ type: "text", text: "—Alfred North Whitehead", styles: {} }],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "It hasn’t even been a year since the launch of Claude Code, the breakout coding agent of the year. Together with its distant but equally competent cousin, Codex, the agents have proven to the software engineering community that real work can be done with these systems. ",
        styles: {},
      },
      {
        type: "link",
        href: "https://www.businessinsider.com/anthropic-claude-cowork-release-ai-vibecoded-2026-1",
        content: [
          {
            type: "text",
            text: "Anthropic’s Cowork was written entirely by Claude Code",
            styles: {},
          },
        ],
      },
      { type: "text", text: ", ", styles: {} },
      {
        type: "link",
        href: "https://openai.com/index/shipping-sora-for-android-with-codex/",
        content: [
          {
            type: "text",
            text: "Sora for Android was entirely done in Codex",
            styles: {},
          },
        ],
      },
      {
        type: "text",
        text: ", and a growing share of everyday development tasks can now be handled wholesale by the agent. Practitioners have been experimenting with feeding progressively more work to agents, to see how much they can get away with without touching the code. Minutes, hours, perhaps even days of hands-off work with the human occasionally checking in to see what got conjured. It’s a profoundly different approach to getting code into a repo, and it demands new strategies for dealing with the side-effects.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The more the genie builds plumbing and functionality blocks that you haven’t looked at, or that you don’t fully understand, the more it’s going to hurt once you hit the limits of the agent and you can’t figure out why “Claude, fix it” is just spinning wheels and suddenly no longer making progress, the user seemingly having run out of wishes to be granted. Jolted out of the joy of typing “proceed” into the CLI, you now have to look under the hood for the first time, and understand a system whose internals you’ve deferred studying for days or weeks, with all of the quirks of a codebase that hasn’t had an active gardener in a while.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "Just how much of this can you get away with?",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " This deferral of understanding is indeed a form of debt, and just like with technical debt, you can get away with some of it, some of the time, but the exact quantity is still something that we’re trying to figure out as a community. And the target is constantly moving as the tools improve around us and let us stretch the limits of our non-understanding further without paying an immediate price.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "If you’ve worked with the tools long enough—a year feels like a century in AI-years—you will have likely started to notice that the more successful the work by the coding agent, the less you feel incentivized to review its work. If most of the time its contribution “just works”, why labor any harder than you have to in order to review every line? Your confidence grows that what you’re getting is going to continue being good, and your desire to second-guess it and review it only lowers with time, as you keep getting better results. ",
        styles: {},
      },
      {
        type: "link",
        href: "https://x.com/tlakomy/status/2023276021563490419?s=20",
        content: [
          {
            type: "text",
            text: "Why inspect the work when instead you could be going even faster?",
            styles: {},
          },
        ],
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The corporate incentives are stacked against it as well. “Our devs are wizards, they’re pushing hundreds of PRs a day, our job is to empower them and get out of their way” is what every frontier podcast is saying, not “our devs are really good at slowing down the pace of change, at making sure they manicure every PR. We wouldn’t want to go any faster than that, we value pacing ourselves and making sure we’re not running as fast as those crazy AI kids.” The beast rewards being fed, until it doesn’t.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      { type: "text", text: "Some call this concept ", styles: { bold: true } },
      {
        type: "link",
        href: "https://simonwillison.net/2026/Feb/15/cognitive-debt/",
        content: [{ type: "text", text: "cognitive", styles: { bold: true } }],
      },
      { type: "text", text: " ", styles: { bold: true } },
      {
        type: "link",
        href: "https://www.media.mit.edu/publications/your-brain-on-chatgpt/",
        content: [{ type: "text", text: "debt", styles: { bold: true } }],
      },
      {
        type: "text",
        text: ", which, if you’re a fan of the revered Team Topologies framework, will instantly resonate. In the book, the authors claim that an engineering team can only manage so much system complexity before maintaining their dominion requires constant re-learning. The knowledge falls out of the mental cache of the engineers, the larger the territory, the more page misses, the slower the work. Engineering managers will then try to maximize page hits by not cognitively stretching developers beyond what they can reasonably fit into their caches. Too big of a domain? Time to simplify the codebase (unlikely) or split it up into teams that can reasonably digest it (likely, but expensive).",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "Do we manage the cognitive load the same way as always in a world of genies?",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " Unclear. The agent dramatically expands the territory a single developer is responsible for, well past what fits in their mental cache. I think of this problem as the ",
        styles: {},
      },
      {
        type: "link",
        href: "https://en.wikipedia.org/wiki/Fog_of_war#In_video_games",
        content: [
          { type: "text", text: '"', styles: {} },
          { type: "text", text: "fog of war", styles: { bold: true } },
          { type: "text", text: '"', styles: {} },
        ],
      },
      {
        type: "text",
        text: " from the world of real-time strategy games. There’s an area of the codebase you haven’t explored in a while, maybe ever. Nobody has ventured out there to get information on its latest state. You have a limited amount of troops, the more you expect an individual SWE to do with their wetware + agentic augmentation, the more areas will stay in the fog of war. Some of them they’ve never explored to begin with, some they can safely guess the contents of based on spec-level conversations with the bot, some they’ve actually had to look at recently and still have fresh in their memory. Plenty of those areas don’t need active scouting, they’re safe, stable, and don’t cause anybody trouble. It’s unlikely anything nasty is going to suddenly sprout out of there, even if it hasn’t been looked at in a while.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The fog of war isn’t a new phenomenon: many engineering teams already don’t have a perfect understanding of the systems they’re building on top of; that’s the power of good abstraction. Maybe it’s a platform they’re building on, maintained by a big vendor, a complex framework curated by an active open-source community. Sometimes it’s legacy code they’ve inherited from someone else at the company.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "I once had to integrate against a system whose creators had all left the company. Nobody even knew who owned it anymore. My manager had to track down former employees by phone, years after they’d left, and by then they could hardly remember how anything worked. The system was almost entirely a black box; all we could do was poke at it from the outside and hope to figure out its behavior from responses and a few old docs on a barely-working internal Sharepoint site.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "Sometimes the case is much more benign: the module or service has worked for years. It was a stable, leak-free abstraction that didn’t cause any trouble and didn’t need to be looked at for ages. Whatever tribal knowledge had been built around it simply decayed over time and now nobody knows how any of it works. The people who originally wrote it either moved on to other projects or forgot completely how any of it works. The docs might have gotten lost somewhere in the shuffle. At least you still have the source code and can figure it out, given time.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "At other times you’re working on top of a giant pile of code that you don’t have time to understand: you need to learn just enough to be able to get your task done. Nobody’s paying you to become a connoisseur of the whole system. Whether that’s modifying Linux, extending Unreal Engine 5, or even building on top of a buffet of browser APIs, there are not enough lifetimes to understand everything beneath your layer. There’s only so much you can fit into a human’s context window at once, and with large systems you quickly run into those limitations.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "But is the product of an agent operating on specs with their human jockey any different from these scenarios?",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " The testing world has long had vocabulary for this spectrum: black-box testing, where you have no visibility into the internals, white-box testing, where you have both visibility and understanding, and grey-box testing, where you have partial knowledge.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The same framing maps neatly onto development postures. With coding agents you’re entering the world of ",
        styles: {},
      },
      { type: "text", text: "grey-box development", styles: { italic: true } },
      {
        type: "text",
        text: ", where you could look at the conjured internals of the system if you wanted to, but you really hope you won’t have to. You hope that the agent’s abstraction is sufficiently self-contained, modular and decoupled that it “just works”. You hope that it made all of the right internal design decisions based on the high level spec that you had agreed upon.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "One curious side-effect of spec-driven development is that, in my experience, your memory of how something works will decay much faster, as you didn’t have to put in the hours schlepping through building a system by hand that is then firmly lodged in your head for weeks or months to come. Everything was more ephemeral, your connection to the deliverable less visceral, after all, you were mostly approving and tweaking the blueprint, not laying the bricks yourself. The fog of war creeps back in faster than in the artisanal dev scenario.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The obvious comparison is to libraries",
        styles: { bold: true },
      },
      {
        type: "text",
        text: ". Most people don’t actually look inside a library’s implementation after downloading it. They sync it down, wire up against it, read the docs (or have the agent do it), and expect it to work right away.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "I think they are indeed different, at least for the popular, well-adopted libraries that most developers gravitate towards. A widely-used library has been smoke-tested by a large number of other developers who used it and were able to report if it worked or not, if it met their use case, if it had any broken corners that tripped them up during testing or production. Your conjured module is more like that brand-new library with 12 GitHub stars that nobody has battle-tested yet. Except ",
        styles: {},
      },
      { type: "text", text: "worse", styles: { italic: true } },
      {
        type: "text",
        text: ", because you’re the first and likely the only user of something perfectly bespoke to your needs. The guarantees are essentially non-existent unless you’ve explicitly tested them yourself. You’re hoping the agent got the performance right, caught predictable corner cases, designed the system in such a way that it’s not spreading ",
        styles: {},
      },
      {
        type: "link",
        href: "https://technology.riotgames.com/news/taxonomy-tech-debt",
        content: [{ type: "text", text: "contagious tech debt", styles: {} }],
      },
      { type: "text", text: " onto everything it interacts with.", styles: {} },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "In the past the developer would have been responsible for knowing every nook and cranny of that system, becoming a deep domain expert in it and being responsible for it in front of the team. But when a developer can crank out a couple of these a day? When the cost of blowing away an isolated module and re-generating it from scratch approaches near zero—assuming no state to migrate, no downstream consumers to coordinate with—is that knowledge worth much anymore?",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "None of this is entirely new. But it’s accelerating.",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " Coding agents are only getting more independent and capable of delivering predictable, higher quality results with each month. It’s hard to imagine frontier product and application teams—the ones actively racing to adopt the latest techniques for a speed advantage—still writing most of their code by hand in late 2026. The only thing holding teams back by then will be the inertia of large companies with well-established moats that won’t be eroded by a faster competitor. Sure, they could go faster, but competition isn’t going to replicate a deeply entrenched brand and thousands of enterprise relationships built over steak dinners. The existential threat is just not there, short of execs pushing top-down an “AI strategy” with little contact with the needs of the troops on the ground. But for hungry, earlier stage teams still in the exploration stage, the faster iteration cycles will make catching up to the big players product-wise and impressing their customers with quick turnaround times easier than ever.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "Are we going to see SWEs move away from attempting to understand most of the code they’re writing",
        styles: { bold: true },
      },
      {
        type: "text",
        text: ", instead relying on the model to figure it out later down the line if something goes wrong? Is the near-future SWE actually ultimately a manager of agent harnesses, one who’s far less technical than their reports? Is the SWE manager going to be expected to roll up their sleeves and fix an issue or re-design a system that the bot complicated to the point of needing torching? Or is the model going to be good enough where the human can just nudge it to fix it and never have to understand the underlying design choices? There are plenty of companies where line or middle managers haven’t made real technical contributions to the codebase in years; they’ve fully delegated the power of changing the codebase to their reports, and operate through those intermediaries. The coding agent could be more of the same pattern we’ve seen for decades, repeated one layer deeper.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "My hunch is that the organization’s bottomless desire to go fast and ship more changes will push developers to know less and less about the code territory they’re stewards of, as long as nothing bad happens along the way.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      { type: "text", text: "Right now we’re in an ", styles: {} },
      {
        type: "text",
        text: "awkward transitional period",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " where we still expect developers to know what they’re working on inside-out, have answers when asked to explain how a module works, while also using agents to move faster. But ultimately the speed vs. understanding tradeoff will push teams to accept that their SWEs don’t fully grok their own modules, and that’s ok, that’s what the model is for. The models will keep getting better for years to come, making “the model has the answers, I’m delegating” only more possible with time. Right now? Not quite there.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      { type: "text", text: "You can think of an ", styles: {} },
      {
        type: "text",
        text: "agent as an outsourcing shop",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " who’s now responsible for understanding, explaining, and evolving that section of the repo. It might be a very ",
        styles: {},
      },
      { type: "text", text: "good", styles: { italic: true } },
      {
        type: "text",
        text: " outsourcing shop—fast, capable, available around the clock—but it’s still a form of delegating the exploration of the fog of war to someone else. The knowledge of what’s actually in there doesn’t automatically flow back to your team. The coordinator steering their work won’t be in the weeds remembering every line of code written by the shop, and unless they’ve explicitly invested in following along every step of the way, the internals become a mysterious blob that nobody on the team can confidently maintain. It’s a bad day if you’re asking that coordinator to roll up their sleeves and fix things themselves.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The fundamentals of software engineering are going nowhere",
        styles: { bold: true },
      },
      {
        type: "text",
        text: " though, and will only increase how much territory under fog of war a single SWE can manage. The more coupled and infectious the system, the more someone has to really think through it and make sure it’s written thoughtfully. Screwing up the shape of an API at the center of many code paths will really suck. Same with the shape of data that has numerous consumers. Sure, refactoring is cheaper than ever now, but these systems are still potentially interacting with the work of many other teams, plus their agents, and team coordination bottlenecks introduce all of the predictable extra friction that you want to be thoughtful about.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "But for something independent and peripheral? You might not have to know anything about it. As long as the tests pass, the module has little to no side-effects, and the cost of mistakes is low, you’re probably better off not wasting time on its internals. For that kind of system, spending time on the guts is becoming more and more akin to the person reviewing the assembly instructions generated by their higher-level application. There’s probably ",
        styles: {},
      },
      { type: "text", text: "some", styles: { italic: true } },
      {
        type: "text",
        text: " value to it, but not enough to justify the activity once the compilers got good enough. But all of this only holds if the tool beneath you is predictable, and that’s where the analogy starts to break down.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The tempting analogy is the compiler",
        styles: { bold: true },
      },
      {
        type: "text",
        text: ", but it’s actually inadequate for what we’re seeing here. Compilers are mostly mechanical mappings from a higher level representation of instructions into their fundamental components. But a high level spec discussion between a SWE and a language model leads to an implementation that can take infinite forms. There’s plenty of room for interpretation, creative solutions, stylistic choices, architectural opinions. The more you ",
        styles: {},
      },
      {
        type: "link",
        href: "https://www.kuril.in/blog/genie-take-the-wheel/",
        content: [{ type: "text", text: "let go of the wheel", styles: {} }],
      },
      {
        type: "text",
        text: " the more you’re leaving up to chance, the more the fog of war is likely to hide something that might surprise you.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "That’s not a compiler, that’s closer to a junior developer you hired but can’t fully supervise, who works at 100x speed and never sleeps. The cognitive debt with a compiler was near zero. The mapping was deterministic, verifiable, and for well-defined inputs you could trust the output without thinking about it. With an agent, the abstraction boundary is ",
        styles: {},
      },
      { type: "text", text: "fuzzy", styles: { italic: true } },
      {
        type: "text",
        text: ". You think in specs and vibes, the agent produces systems, and the mapping is… a mystery. You hope it understood you. You hope its judgment was sound. And the understandable inclination is to leave those implementation details unexplored if they usually work well enough.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The natural counterargument is that automated testing is the torch you throw into the fog of war. If you have comprehensive tests that cover the spec, do you really need to understand the internals? In theory, no. In practice, writing tests thorough enough to substitute for understanding is itself a significant investment. You need to anticipate corner cases, performance characteristics, concurrency edge cases, and failure modes that you might not even know to test for if you didn’t participate in the design. Tests are an excellent mitigation, possibly the best one we have, but they’re not free, and the temptation to under-invest in them grows in lockstep with the temptation to skip human code review.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "There’s also a dimension that gets surprisingly little airtime in these discussions: ",
        styles: {},
      },
      { type: "text", text: "security", styles: { bold: true } },
      {
        type: "text",
        text: ". The scariest thing hiding in the fog of war isn’t code that doesn’t work. It’s code that works perfectly while being quietly exploitable. An agent that conjures a system you never review is an agent that might introduce vulnerabilities you never catch. It’s possible that this too will be addressed by specialized agents, security-focused genies whose entire job is to audit the output of the coding genies. But that’s still delegating the problem to a different black box. At some point the chain of agents auditing agents has to bottom out at something a human has verified, and whether teams will invest in closing that loop is an open question. At the same time, is this any different from the current state of things, with many early stage teams treating security as an afterthought as they’re chasing product-market fit and more growth? The agent might actually provide them with a more robust implementation than the one they would have bothered with.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      { type: "text", text: "So are we ", styles: {} },
      {
        type: "text",
        text: "becoming dependent on something we can’t understand",
        styles: { bold: true },
      },
      {
        type: "text",
        text: ", and is that dependency qualitatively different from every previous abstraction layer we relied upon? The answer is likely yes, and we’re not sure if it’s fine. It’s unclear if the acceleration in delivery speed at the cost of visibility is sustainable long-term. Will we ultimately reach an asymptote of how much a developer can outsource “low level thinking”, or will the models keep improving to the point where SWEs are describing solutions at a highly abstract level and consistently getting something that “just works”? I’m not sure if that’s even possible, if you can get what you want when you never said exactly what it was, if you perhaps didn’t even know it yourself.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "It’s hard to imagine a world in which you’ll get what you want without getting into the weeds of the details, but people have expressed skepticism about the viability of agentic coding the whole way here, and look at where we are now. Dismissing something as just a toy for unserious work is a classic trap of the Innovator’s Dilemma, and we might be in one right now. If the trajectory continues, perhaps the genie learns to grant wishes in a way that never disappoints us, even though it might not be exactly the approach we would have chosen ourselves. And if it does, we should expect engineering judgment to decay, the muscle atrophying with disuse, our dependence on agents becoming complete. But it also may be the tradeoff everybody picks, because getting something that is mostly there, but 100x faster, is better in an industrial context than getting just the perfect solution at a far higher cost.",
        styles: {},
      },
    ],
  },
  {
    kind: "paragraph",
    content: [
      {
        type: "text",
        text: "The code nobody reads might just be the code of the future. The question is whether that’s a triumph of abstraction or a debt we haven’t yet been asked to repay.",
        styles: {},
      },
    ],
  },
];

export function buildDemoArticleBlocks(): BlockNoteBlock[] {
  return demoEntries.map((entry) => {
    const type: SupportedBlockType =
      entry.kind === "heading"
        ? "heading"
        : entry.kind === "quote"
          ? "quote"
          : "paragraph";
    const props: Record<string, unknown> =
      entry.kind === "heading" ? { level: entry.level } : {};
    return {
      id: crypto.randomUUID(),
      type,
      props,
      content: entry.content,
      children: [],
    };
  });
}
