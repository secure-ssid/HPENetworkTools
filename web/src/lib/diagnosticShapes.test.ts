import { describe, expect, it } from 'vitest';
import type {
  DiagnosticEligibilityResponse,
  DiagnosticJob,
  DiagnosticReview,
} from '../../../shared';

describe('shared diagnostic contracts', () => {
  it('carry the reviewed path, live eligibility source, and cancel-safe job states', () => {
    const eligibility: DiagnosticEligibilityResponse = {
      operation: 'traceroute',
      source: 'live-inventory',
      devices: [],
    };
    const review: DiagnosticReview = {
      reviewId: 'r1',
      expiresAt: '2026-07-29T12:00:00Z',
      device: 'cx-1',
      serial: 'CX1',
      plane: 'CENTRAL',
      deviceClass: 'cx',
      operation: 'traceroute',
      target: 'example.net',
      options: {},
      startPath: '/network-troubleshooting/v1/cx/CX1/traceroute',
      pollPathTemplate: '/network-troubleshooting/v1/cx/CX1/traceroute/async-operations/{task-id}',
      warning: 'operational action',
    };
    const cancelled: DiagnosticJob = {
      id: 'j1',
      device: review.device,
      serial: review.serial,
      plane: review.plane,
      deviceClass: review.deviceClass,
      operation: review.operation,
      state: 'cancelled',
      taskId: null,
      progressPercent: 0,
      startedAt: review.expiresAt,
      finishedAt: review.expiresAt,
      message: 'cancelled',
      result: null,
    };
    expect(eligibility.source).toBe('live-inventory');
    expect(review.startPath).toContain('/cx/CX1/traceroute');
    expect(cancelled.state).toBe('cancelled');
  });
});
