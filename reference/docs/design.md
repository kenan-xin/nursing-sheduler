# Design Philosophy

### Choice of Solver

Since I'm not an expert in operations research, I've done some research on suitable (open-source) solvers for this problem. The most popular ones seem to be [Timefold](https://github.com/TimefoldAI/timefold-solver) (previously [OptaPlanner](https://github.com/kiegroup/optaplanner)) and [Google OR-Tools](https://github.com/google/or-tools). There's also a [comparison](https://www.optaplanner.org/competitor/or-tools.html) between the two.

Google OR-Tools' CP-SAT solver is the only backend we ship. It was chosen for its Python bindings, which is the language this project is built in, and for its ability to prove schedule optimality (or infeasibility) within bounded runtimes at the scale we target.

### Choice of Input Format

We prioritize human readability and ease of editing by hand over machine parsing simplicity.

The YAML format uses camelCase field names, following the conventions of Kubernetes.

To allow quick prototyping without defining data type classes, we choose to keep the YAML input intact in memory. This requires extracting data explicitly using utility functions.

<!-- TODO: Compare with INRC format and describe the differences and rationale) -->