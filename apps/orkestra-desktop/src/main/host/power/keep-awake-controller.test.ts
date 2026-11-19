import { describe, expect, it } from 'vitest';
import { createKeepAwakeController, type PowerBlockerPort } from './keep-awake-controller';

function fakeBlocker() {
  let nextId = 1;
  const active = new Set<number>();
  const calls: string[] = [];
  const port: PowerBlockerPort = {
    start(type) {
      calls.push(`start:${type}`);
      const id = nextId++;
      active.add(id);
      return id;
    },
    stop(id) {
      calls.push(`stop:${id}`);
      if (!active.delete(id)) throw new Error(`double stop ${id}`);
    },
  };
  return { port, active, calls };
}

describe('createKeepAwakeController', () => {
  it('holds one blocker while at least one conversation works (0 -> 1 -> 2 -> 1 -> 0)', () => {
    const { port, active, calls } = fakeBlocker();
    const controller = createKeepAwakeController(port);
    controller.setEnabled(true);
    expect(active.size).toBe(0);

    controller.setWorkingCount(1);
    expect(active.size).toBe(1);
    controller.setWorkingCount(2);
    expect(active.size).toBe(1);
    controller.setWorkingCount(1);
    expect(active.size).toBe(1);
    controller.setWorkingCount(0);
    expect(active.size).toBe(0);
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1']);
  });

  it('never holds while the setting is off, and starts once the setting turns on', () => {
    const { port, active } = fakeBlocker();
    const controller = createKeepAwakeController(port);
    controller.setWorkingCount(3);
    expect(active.size).toBe(0);
    controller.setEnabled(true);
    expect(active.size).toBe(1);
    expect(controller.isHeld).toBe(true);
  });

  it('releases when the setting is turned off', () => {
    const { port, active } = fakeBlocker();
    const controller = createKeepAwakeController(port);
    controller.setEnabled(true);
    controller.setWorkingCount(1);
    controller.setEnabled(false);
    expect(active.size).toBe(0);
    expect(controller.isHeld).toBe(false);
    controller.setEnabled(true);
    expect(active.size).toBe(1);
  });

  it('does not start or stop twice on repeated identical input', () => {
    const { port, calls } = fakeBlocker();
    const controller = createKeepAwakeController(port);
    controller.setEnabled(true);
    controller.setEnabled(true);
    controller.setWorkingCount(1);
    controller.setWorkingCount(1);
    controller.setWorkingCount(0);
    controller.setWorkingCount(0);
    controller.setEnabled(false);
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1']);
  });

  it('releases on dispose and stays released afterwards', () => {
    const { port, active, calls } = fakeBlocker();
    const controller = createKeepAwakeController(port);
    controller.setEnabled(true);
    controller.setWorkingCount(1);
    controller.dispose();
    expect(active.size).toBe(0);
    controller.setWorkingCount(5);
    controller.setEnabled(true);
    controller.dispose();
    expect(active.size).toBe(0);
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1']);
  });

  it('treats invalid counts as zero', () => {
    const { port, active } = fakeBlocker();
    const controller = createKeepAwakeController(port);
    controller.setEnabled(true);
    controller.setWorkingCount(1);
    controller.setWorkingCount(Number.NaN);
    expect(active.size).toBe(0);
    controller.setWorkingCount(-3);
    expect(active.size).toBe(0);
  });
});
