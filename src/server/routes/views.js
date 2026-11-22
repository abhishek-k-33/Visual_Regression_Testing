import express from 'express';
import { indexModel, runDetailModel } from '../viewModels.js';

const router = express.Router();

function renderError(res, heading, err) {
  res.status(500).render('layout', { title: 'Error', heading, message: err.message });
}

/**
 * GET /
 * Dashboard homepage: lists all test runs with status cards and summary badges.
 */
router.get('/', (req, res) => {
  try {
    res.render('index', indexModel());
  } catch (err) {
    renderError(res, 'Error Loading Dashboard', err);
  }
});

/**
 * GET /runs/:id
 * Detail view: inspects individual snapshots of a run with side-by-side, slider, and diff views.
 */
router.get('/runs/:id', (req, res) => {
  try {
    const model = runDetailModel({ runId: req.params.id });
    if (!model) {
      return res.status(404).render('index', {
        ...indexModel(),
        title: 'Run Not Found',
        error: `Test run "${req.params.id}" not found.`
      });
    }
    res.render('run-detail', model);
  } catch (err) {
    renderError(res, 'Error Loading Run', err);
  }
});

export default router;
