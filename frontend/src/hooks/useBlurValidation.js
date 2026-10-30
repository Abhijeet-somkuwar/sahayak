import { useEffect, useRef } from 'react';

/**
 * Validation timing (§8.1): validate a field on blur, then on change once it has an error,
 * everything on submit. If the blur was caused by pressing the submit button, wait for the
 * pointer to lift first so the error message cannot push the button out from under the pointer.
 *
 * Usage with Ant Design Form:  const onBlur = useBlurValidation(form);  <Input onBlur={onBlur('name')} />
 */
export function useBlurValidation(form) {
  const pressing = useRef(false);
  useEffect(() => {
    const down = () => (pressing.current = true);
    const up = () => (pressing.current = false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
  }, []);

  return (name) => () => {
    const validate = () => form.validateFields([name]).catch(() => {});
    if (!pressing.current) return validate();
    const once = () => {
      document.removeEventListener('pointerup', once, true);
      document.removeEventListener('pointercancel', once, true);
      setTimeout(validate, 0);
    };
    document.addEventListener('pointerup', once, true);
    document.addEventListener('pointercancel', once, true);
    return undefined;
  };
}
