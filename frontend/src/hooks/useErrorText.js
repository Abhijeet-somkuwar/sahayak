import { useTranslation } from 'react-i18next';
import { describeError } from '../utils/errors';

// Turns any error into the sentence the user should see.
export function useErrorText() {
  const { t } = useTranslation();
  return (e) => {
    const d = describeError(e);
    return t(d.key, d.params);
  };
}
