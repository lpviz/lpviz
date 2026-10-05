// The documentation pages in nav and reading order: the overview first, then the
// articles. Each page's body is the fragment of the same name next to this file
// (the markup between <article> and the pager); render.ts wraps it in the shared
// head, nav, pager, footer and JSON-LD.

export interface DocsPage {
  /** URL segment under /docs/ and the body fragment's file name; "index" is the overview at /docs/. */
  slug: string;
  /** Link text in the header nav and the breadcrumb. */
  nav: string;
  /** Link text in the neighbouring pages' pager. */
  pager: string;
  title: string;
  description: string;
  og: { title: string; description: string };
  twitter: { title: string; description: string };
  /** schema.org name and description: a TechArticle, or the CollectionPage for the overview. */
  schema: { name: string; description: string };
}

export const DOCS_PAGES: readonly DocsPage[] = [
  {
    slug: "index",
    nav: "Docs",
    pager: "Docs overview",
    title: "lpviz Documentation — Visualize Linear Programming Solvers",
    description:
      "How lpviz works: draw a feasible region, pick an objective, and watch the Simplex method, interior point methods (IPM), PDHG, the ellipsoid method, and the central path solve your linear program step by step.",
    og: {
      title: "lpviz Documentation — Visualize Linear Programming Solvers",
      description: "Interactive guides to the Simplex method, interior point methods, PDHG, the ellipsoid method, and the central path — with a browser app that animates every iteration.",
    },
    twitter: {
      title: "lpviz Documentation",
      description: "Interactive guides to the Simplex method, interior point methods, PDHG, the ellipsoid method, and the central path.",
    },
    schema: { name: "lpviz Documentation", description: "Guides to the linear programming algorithms visualized by lpviz." },
  },
  {
    slug: "simplex",
    nav: "Simplex",
    pager: "The Simplex Method",
    title: "The Simplex Method, Visualized — lpviz Docs",
    description:
      "How the Simplex method solves linear programs by walking from vertex to vertex: two-phase setup, Bland's and Dantzig's pivot rules, degenerate pivots, and dual simplex — visualized interactively in lpviz.",
    og: {
      title: "The Simplex Method, Visualized",
      description: "Watch the Simplex algorithm pivot from vertex to vertex of a polytope you draw: two phases, Bland's and Dantzig's pivot rules, unboundedness, and dual simplex, explained.",
    },
    twitter: { title: "The Simplex Method, Visualized — lpviz", description: "Two-phase simplex, Bland's and Dantzig's rules, and dual simplex on polytopes you draw." },
    schema: {
      name: "The Simplex Method",
      description: "How the Simplex method solves linear programs by pivoting between vertices, and how lpviz implements and visualizes it.",
    },
  },
  {
    slug: "interior-point",
    nav: "Interior Point",
    pager: "Interior Point Methods",
    title: "Interior Point Methods, Visualized — lpviz Docs",
    description:
      "How primal-dual interior point methods solve linear programs: the central path, Mehrotra's predictor-corrector, fraction-to-boundary steps, and infeasible starts — visualized interactively in lpviz.",
    og: {
      title: "Interior Point Methods, Visualized",
      description: "Watch a Mehrotra predictor-corrector interior point method arc through the interior of a polytope you draw, and learn what every knob does.",
    },
    twitter: { title: "Interior Point Methods, Visualized — lpviz", description: "The central path, predictor-corrector steps, and infeasible starts, animated on polytopes you draw." },
    schema: {
      name: "Interior Point Methods",
      description: "How primal-dual interior point methods for linear programming work, and how lpviz implements a Mehrotra-style predictor-corrector method.",
    },
  },
  {
    slug: "pdhg",
    nav: "PDHG",
    pager: "PDHG",
    title: "PDHG for Linear Programming, Visualized — lpviz Docs",
    description:
      "How the primal-dual hybrid gradient (PDHG) method solves linear programs with only matrix-vector products: step sizes, spiraling dynamics, Halpern acceleration with restarts, and basis identification — visualized in lpviz.",
    og: {
      title: "PDHG for Linear Programming, Visualized",
      description: "The first-order method behind GPU LP solvers like PDLP: watch PDHG spiral into the optimum, diverge when step sizes are too big, and accelerate with Halpern restarts.",
    },
    twitter: { title: "PDHG, Visualized — lpviz", description: "Primal-dual hybrid gradient dynamics, Halpern restarts, and basis identification on LPs you draw." },
    schema: {
      name: "PDHG: Primal-Dual Hybrid Gradient",
      description: "How the primal-dual hybrid gradient method solves linear programs, and how lpviz implements and visualizes it, including Halpern acceleration with restarts.",
    },
  },
  {
    slug: "ellipsoid",
    nav: "Ellipsoid",
    pager: "The Ellipsoid Method",
    title: "The Ellipsoid Method and Cutting Planes, Visualized — lpviz Docs",
    description:
      "How the ellipsoid method solves linear programs by shrinking a localizing set around the optimum: deep cuts, the objective ray shoot, the ρ certificate, and the Chebyshev, analytic and volumetric cutting-plane query points — visualized interactively in lpviz.",
    og: {
      title: "The Ellipsoid Method and Cutting Planes, Visualized",
      description: "Watch a localizing ellipsoid shrink onto the optimum of a polytope you draw, and compare it with the Chebyshev, analytic and volumetric cutting-plane query points.",
    },
    twitter: { title: "The Ellipsoid Method, Visualized — lpviz", description: "Localizing sets, deep cuts, ray shooting, and four choices of query point on LPs you draw." },
    schema: {
      name: "The Ellipsoid Method",
      description: "How the ellipsoid method localizes the optimum of a linear program, what each of its options does, and how lpviz's cutting-plane query points differ from it.",
    },
  },
  {
    slug: "central-path",
    nav: "Central Path",
    pager: "The Central Path",
    title: "The Central Path and Log Barrier, Visualized — lpviz Docs",
    description:
      "The central path of a linear program: how the logarithmic barrier turns constraints into a smooth landscape, how Newton's method traces the path from analytic center to optimum, and what it reveals about interior point methods.",
    og: {
      title: "The Central Path and Log Barrier, Visualized",
      description: "Trace the smooth curve connecting the analytic center of a polytope to its optimal vertex, computed with Newton's method on the log-barrier problem.",
    },
    twitter: { title: "The Central Path, Visualized — lpviz", description: "Log barriers, analytic centers, and the smooth road to the optimum of a linear program." },
    schema: {
      name: "The Central Path",
      description: "What the central path of a linear program is, how lpviz traces it with Newton's method on log-barrier subproblems, and how it relates to interior point methods.",
    },
  },
];
