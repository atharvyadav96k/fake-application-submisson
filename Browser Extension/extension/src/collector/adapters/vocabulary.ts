import type { CanonicalField } from '@/models/field';

export interface VocabularyRule {
  canonical: CanonicalField;
  phrases: string[];
  negative?: string[];
  autocomplete?: string[];
  weight?: number;
  group?: string;
}

export const VOCABULARY: VocabularyRule[] = [
  {
    canonical: 'first_name',
    phrases: ['first name', 'given name', 'forename', 'fname', 'firstname'],
    negative: ['last', 'family', 'company'],
    autocomplete: ['given-name'],
  },
  {
    canonical: 'last_name',
    phrases: ['last name', 'family name', 'surname', 'lname', 'lastname'],
    negative: ['first', 'given'],
    autocomplete: ['family-name'],
  },
  {
    canonical: 'full_name',
    phrases: ['full name', 'your name', 'name', 'candidate name', 'applicant name'],
    negative: ['first', 'last', 'company', 'employer', 'school', 'university', 'file', 'user', 'referrer'],
    autocomplete: ['name'],
    weight: 0.6,
  },
  {
    canonical: 'preferred_name',
    phrases: ['preferred name', 'nickname', 'known as', 'display name'],
    autocomplete: ['nickname'],
  },
  {
    canonical: 'email',
    phrases: ['email', 'e-mail', 'email address', 'mail id'],
    negative: ['confirm', 'referrer', 'manager'],
    autocomplete: ['email'],
  },
  {
    canonical: 'phone',
    phrases: ['phone', 'mobile', 'telephone', 'contact number', 'cell', 'phone number'],
    autocomplete: ['tel', 'tel-national'],
  },
  {
    canonical: 'address',
    phrases: ['address', 'street address', 'address line 1', 'residential address'],
    negative: ['email', 'line 2', 'ip'],
    autocomplete: ['street-address', 'address-line1'],
  },
  {
    canonical: 'address_line_2',
    phrases: ['address line 2', 'apartment', 'suite', 'unit'],
    autocomplete: ['address-line2'],
  },
  { canonical: 'city', phrases: ['city', 'town', 'locality'], autocomplete: ['address-level2'] },
  {
    canonical: 'state',
    phrases: ['state', 'province', 'region', 'county'],
    autocomplete: ['address-level1'],
  },
  {
    canonical: 'postal_code',
    phrases: ['postal code', 'postcode', 'zip', 'zip code', 'pin code'],
    autocomplete: ['postal-code'],
  },
  { canonical: 'country', phrases: ['country', 'nation'], autocomplete: ['country', 'country-name'] },
  {
    canonical: 'current_company',
    phrases: ['current company', 'company', 'employer', 'organisation', 'organization', 'current employer', 'firm'],
    negative: ['size', 'website', 'previous', 'former'],
    autocomplete: ['organization'],
  },
  {
    canonical: 'current_job_title',
    phrases: ['job title', 'current title', 'designation', 'position', 'role', 'current role', 'occupation'],
    negative: ['applied', 'applying', 'desired', 'preferred'],
    autocomplete: ['organization-title'],
  },
  { canonical: 'employer_name', phrases: ['employer name', 'previous employer', 'company name'], group: 'employer' },
  { canonical: 'employer_title', phrases: ['title at', 'position held', 'role at'], group: 'employer' },
  { canonical: 'employer_start_date', phrases: ['start date', 'from date', 'employed from'], group: 'employer' },
  { canonical: 'employer_end_date', phrases: ['end date', 'to date', 'employed until', 'employed to'], group: 'employer' },
  {
    canonical: 'experience_years',
    phrases: ['years of experience', 'total experience', 'experience in years', 'yoe', 'work experience'],
  },
  { canonical: 'notice_period', phrases: ['notice period', 'notice', 'availability to join'] },
  { canonical: 'current_salary', phrases: ['current salary', 'current ctc', 'present salary'] },
  { canonical: 'expected_salary', phrases: ['expected salary', 'expected ctc', 'desired salary', 'salary expectation'] },
  {
    canonical: 'education_institution',
    phrases: ['university', 'college', 'school', 'institution', 'institute'],
    group: 'education',
  },
  { canonical: 'education_degree', phrases: ['degree', 'qualification', 'education level'], group: 'education' },
  { canonical: 'education_field', phrases: ['field of study', 'major', 'discipline', 'specialisation', 'specialization'], group: 'education' },
  { canonical: 'graduation_year', phrases: ['graduation year', 'year of passing', 'completion year'], group: 'education' },
  { canonical: 'linkedin_url', phrases: ['linkedin', 'linkedin profile', 'linkedin url'] },
  { canonical: 'github_url', phrases: ['github', 'github profile', 'git hub'] },
  { canonical: 'portfolio_url', phrases: ['portfolio', 'portfolio url', 'behance', 'dribbble'] },
  {
    canonical: 'website',
    phrases: ['website', 'personal site', 'blog', 'url'],
    negative: ['linkedin', 'github', 'portfolio', 'company'],
    autocomplete: ['url'],
    weight: 0.6,
  },
  { canonical: 'resume', phrases: ['resume', 'cv', 'curriculum vitae', 'upload resume', 'attach resume'] },
  { canonical: 'cover_letter', phrases: ['cover letter', 'covering letter', 'motivation letter', 'why do you want'] },
  {
    canonical: 'work_authorization',
    phrases: ['work authorization', 'work authorisation', 'right to work', 'legally authorized', 'eligible to work'],
  },
  { canonical: 'visa_status', phrases: ['visa', 'sponsorship', 'require sponsorship', 'immigration status'] },
  { canonical: 'availability_date', phrases: ['available from', 'availability date', 'start availability', 'earliest start'] },
  { canonical: 'relocation', phrases: ['relocate', 'relocation', 'willing to move'] },
  { canonical: 'date_of_birth', phrases: ['date of birth', 'dob', 'birth date', 'birthday'], autocomplete: ['bday'] },
  { canonical: 'gender', phrases: ['gender', 'sex'] },
  { canonical: 'nationality', phrases: ['nationality', 'citizenship'] },
  { canonical: 'national_id', phrases: ['national id', 'national insurance', 'aadhaar', 'pan card', 'passport number'] },
  { canonical: 'ssn', phrases: ['ssn', 'social security'] },
  { canonical: 'password', phrases: ['password', 'passcode'], autocomplete: ['current-password', 'new-password'] },
  { canonical: 'otp', phrases: ['otp', 'one time password', 'verification code', 'security code', '2fa'] },
  { canonical: 'credit_card', phrases: ['card number', 'credit card'], autocomplete: ['cc-number'] },
  { canonical: 'cvv', phrases: ['cvv', 'cvc', 'card verification'], autocomplete: ['cc-csc'] },
];

/** Reverse index: autocomplete token -> canonical field. */
export const AUTOCOMPLETE_MAP: Record<string, CanonicalField> = (() => {
  const map: Record<string, CanonicalField> = {};
  for (const rule of VOCABULARY) {
    for (const token of rule.autocomplete ?? []) map[token] = rule.canonical;
  }
  return map;
})();

/** input[type] -> canonical hint, used as a weak corroborating signal only. */
export const INPUT_TYPE_HINTS: Partial<Record<string, CanonicalField>> = {
  email: 'email',
  tel: 'phone',
  password: 'password',
  url: 'website',
};

/** Canonical fields that a typical application form is expected to contain. */
export const COMMONLY_EXPECTED_FIELDS: CanonicalField[] = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'resume',
];
