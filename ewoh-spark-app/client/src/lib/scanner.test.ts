import {
  createScannerListener,
  hasBarcodeDetector,
  playScanFeedback,
  vibratePattern,
  type ScannerListener,
} from './scanner';

function keyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as KeyboardEvent;
}

describe('scanner', () => {
  it('buffers alphanumeric keys and fires onScan on Enter', () => {
    const onScan = jest.fn();
    const listener: ScannerListener = createScannerListener({ onScan });
    for (const char of 'ABC123') {
      listener.handleKeyDown(keyEvent(char));
    }
    listener.handleKeyDown(keyEvent('Enter'));
    expect(onScan).toHaveBeenCalledWith('ABC123');
  });

  it('rejects scans shorter than the minimum length', () => {
    const onError = jest.fn();
    const listener: ScannerListener = createScannerListener(
      { onScan: jest.fn(), onError },
      { minLength: 5 },
    );
    listener.handleKeyDown(keyEvent('12'));
    listener.handleKeyDown(keyEvent('Enter'));
    expect(onError).toHaveBeenCalledWith('扫码内容过短');
  });

  it('resets the buffer on an interleaved functional key', () => {
    const onScan = jest.fn();
    const listener: ScannerListener = createScannerListener({ onScan });
    listener.handleKeyDown(keyEvent('A'));
    listener.handleKeyDown(keyEvent('Escape'));
    listener.handleKeyDown(keyEvent('B'));
    listener.handleKeyDown(keyEvent('C'));
    listener.handleKeyDown(keyEvent('D'));
    listener.handleKeyDown(keyEvent('Enter'));
    expect(onScan).toHaveBeenCalledWith('BCD');
  });

  it('ignores modifier keys while scanning', () => {
    const onScan = jest.fn();
    const listener: ScannerListener = createScannerListener({ onScan });
    listener.handleKeyDown(keyEvent('Shift'));
    listener.handleKeyDown(keyEvent('1'));
    listener.handleKeyDown(keyEvent('2'));
    listener.handleKeyDown(keyEvent('3'));
    listener.handleKeyDown(keyEvent('Enter'));
    expect(onScan).toHaveBeenCalledWith('123');
  });

  it('provides vibration patterns without throwing', () => {
    // In node (no navigator.vibrate) this returns null; in a browser it returns a pattern.
    const pattern = vibratePattern('success');
    expect(pattern === null || Array.isArray(pattern)).toBe(true);
    expect(() => playScanFeedback('success')).not.toThrow();
  });

  it('reports BarcodeDetector availability', () => {
    expect(typeof hasBarcodeDetector()).toBe('boolean');
  });
});