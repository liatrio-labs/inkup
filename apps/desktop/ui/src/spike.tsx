// The panel spike's page (spec 03, Unit 1): one per display, inside a non-activating panel. A full-window canvas
// where a drag draws a stroke, and a label naming the display. Throwaway: the overlay replaces it.
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind.css';

/** DESIGN.md's pen colour. */
const PEN = '#e5484d';
const WIDTH = 4;

function SpikeOverlay({ display }: { display: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    // Backing pixels at the display's scale, so the stroke is as sharp as the screen.
    const sizeToWindow = () => {
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * scale);
      canvas.height = Math.round(window.innerHeight * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = WIDTH;
      context.strokeStyle = PEN;
    };
    sizeToWindow();

    let last: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      last = { x: event.clientX, y: event.clientY };
    };
    const move = (event: PointerEvent) => {
      if (!last) return;
      context.beginPath();
      context.moveTo(last.x, last.y);
      context.lineTo(event.clientX, event.clientY);
      context.stroke();
      last = { x: event.clientX, y: event.clientY };
    };
    const up = () => {
      last = null;
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    window.addEventListener('resize', sizeToWindow);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      window.removeEventListener('resize', sizeToWindow);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="fixed inset-0 h-full w-full cursor-crosshair touch-none" />
      <p className="pointer-events-none fixed top-4 left-4 rounded-md bg-background/85 px-3 py-1.5 text-foreground text-sm shadow-sm">
        InkUp spike on {display}. Choose “Spike: catch pointer” in the menu bar, then drag to draw.
      </p>
    </>
  );
}

const display = new URLSearchParams(window.location.search).get('display') || 'this display';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpikeOverlay display={display} />
  </StrictMode>,
);
