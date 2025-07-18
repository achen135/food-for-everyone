"""The seeded generative model behind the ml corpus.

Read `ml/docs/simulator.md` before trusting a number that came out of here.
Everything the model can teach is something this package put in.
"""

from ml.simulate.config import SimulationConfig
from ml.simulate.engine import simulate

__all__ = ["SimulationConfig", "simulate"]
